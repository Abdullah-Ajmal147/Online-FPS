import type { Equipment } from '@sentinel/content';
import { TICK_RATE, type Rapier, type Vec3 } from '@sentinel/shared';

type World = InstanceType<Rapier['World']>;

/** Seconds per tick. Gravity is the movement gravity, so throws arc like jumps. */
const DT = 1 / TICK_RATE;
/** Grenade radius: keeps it from sinking into surfaces when it bounces. */
const RADIUS = 0.07;
/** Below this speed on a floor it stops rolling. */
const REST_SPEED = 0.8;
/** Keeps some speed along a surface on each bounce (rolling friction). */
const TANGENT_KEEP = 0.75;
/** A thrown grenade also goes up a bit, so a throw at the horizon still lobs. */
const LOB_UP = 3;

export interface Projectile {
  /** Wire id (wraps at 256; at most a handful exist at once). */
  id: number;
  def: Equipment;
  ownerId: number;
  ownerTeam: number;
  position: Vec3;
  velocity: [number, number, number];
  /** Ticks until the fuse goes off. */
  fuseTicks: number;
  /** Smoke only: ticks the released cloud still lasts (0 while still flying). */
  cloudTicks: number;
}

export interface Detonation {
  projectile: Projectile;
  position: Vec3;
}

/**
 * Thrown equipment, simulated only on the server (clients draw what snapshots say; nothing
 * about a grenade is predicted or trusted from a client). Plain ballistic flight with bounces
 * off the map, using the same Rapier world as movement and shots.
 */
export class Grenades {
  readonly list: Projectile[] = [];
  private nextId = 0;

  constructor(
    private readonly rapier: Rapier,
    private readonly world: World,
    private readonly gravity: number,
  ) {}

  /**
   * Throw from an eye position along a view direction. The start point is pulled back if a wall
   * is closer than the hand, so a grenade thrown into a wall never starts on its far side.
   */
  throw(def: Equipment, ownerId: number, ownerTeam: number, eye: Vec3, dir: Vec3, carry: Vec3) {
    const reach = 0.5;
    const blocked = this.cast(eye, dir, reach);
    const d = blocked === null ? reach : Math.max(0, blocked - RADIUS * 2);
    const p: Projectile = {
      id: this.nextId++ & 0xff,
      def,
      ownerId,
      ownerTeam,
      position: [eye[0] + dir[0] * d, eye[1] + dir[1] * d, eye[2] + dir[2] * d],
      velocity: [
        dir[0] * def.throwSpeed + carry[0] * 0.5,
        dir[1] * def.throwSpeed + LOB_UP + carry[1] * 0.5,
        dir[2] * def.throwSpeed + carry[2] * 0.5,
      ],
      fuseTicks: Math.max(1, Math.round(def.fuseTime * TICK_RATE)),
      cloudTicks: 0,
    };
    this.list.push(p);
    return p;
  }

  /** One tick: fly, bounce, count fuses down. Returns what went off this tick. */
  step(): Detonation[] {
    const out: Detonation[] = [];
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]!;
      if (p.cloudTicks > 0) {
        if (--p.cloudTicks === 0) this.list.splice(i, 1);
        continue;
      }
      this.fly(p);
      if (--p.fuseTicks > 0) continue;
      out.push({ projectile: p, position: [...p.position] });
      if (p.def.smoke) {
        p.cloudTicks = Math.round(p.def.smoke.duration * TICK_RATE);
        p.velocity = [0, 0, 0];
      } else {
        this.list.splice(i, 1);
      }
    }
    return out;
  }

  /** Remove a leaving player's grenades that are still flying (their clouds stay). */
  removeOwner(ownerId: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]!;
      if (p.ownerId === ownerId && p.cloudTicks === 0) this.list.splice(i, 1);
    }
  }

  clear(): void {
    this.list.length = 0;
  }

  /** Smoke clouds currently up (for vision checks). */
  *clouds(): Generator<{ position: Vec3; radius: number }> {
    for (const p of this.list) {
      if (p.cloudTicks > 0 && p.def.smoke)
        yield { position: p.position, radius: p.def.smoke.radius };
    }
  }

  /** True if the segment a→b passes through any smoke cloud. */
  smokeBlocks(a: Vec3, b: Vec3): boolean {
    for (const c of this.clouds()) {
      if (segmentSphere(a, b, c.position, c.radius)) return true;
    }
    return false;
  }

  private fly(p: Projectile): void {
    const v = p.velocity;
    v[1] -= this.gravity * DT;
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed === 0) return;
    const move = speed * DT;
    const dir: Vec3 = [v[0] / speed, v[1] / speed, v[2] / speed];
    const hit = this.castWithNormal(p.position, dir, move + RADIUS);
    if (!hit) {
      p.position = [
        p.position[0] + v[0] * DT,
        p.position[1] + v[1] * DT,
        p.position[2] + v[2] * DT,
      ];
      return;
    }
    // Stop just short of the surface, then reflect: v' = v − (1 + e)(v·n)n, and lose some of
    // the sliding speed too.
    const travel = Math.max(0, hit.distance - RADIUS);
    p.position = [
      p.position[0] + dir[0] * travel,
      p.position[1] + dir[1] * travel,
      p.position[2] + dir[2] * travel,
    ];
    const n = hit.normal;
    const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    const e = p.def.restitution;
    for (let k = 0; k < 3; k++) {
      const normal = vn * n[k]!;
      const tangent = v[k]! - normal;
      v[k] = tangent * TANGENT_KEEP - normal * e;
    }
    if (n[1] > 0.7 && Math.hypot(v[0], v[1], v[2]) < REST_SPEED) v.fill(0);
  }

  private cast(from: Vec3, dir: Vec3, max: number): number | null {
    const hit = this.world.castRay(
      new this.rapier.Ray(
        { x: from[0], y: from[1], z: from[2] },
        { x: dir[0], y: dir[1], z: dir[2] },
      ),
      max,
      true,
      this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    return hit ? hit.timeOfImpact : null;
  }

  private castWithNormal(
    from: Vec3,
    dir: Vec3,
    max: number,
  ): { distance: number; normal: Vec3 } | null {
    const hit = this.world.castRayAndGetNormal(
      new this.rapier.Ray(
        { x: from[0], y: from[1], z: from[2] },
        { x: dir[0], y: dir[1], z: dir[2] },
      ),
      max,
      true,
      this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    if (!hit) return null;
    return { distance: hit.timeOfImpact, normal: [hit.normal.x, hit.normal.y, hit.normal.z] };
  }
}

/** Does the segment a→b come within r of centre c? */
export function segmentSphere(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, (ac[0] * ab[0] + ac[1] * ab[1] + ac[2] * ab[2]) / len2));
  const dx = a[0] + ab[0] * t - c[0];
  const dy = a[1] + ab[1] * t - c[1];
  const dz = a[2] + ab[2] * t - c[2];
  return dx * dx + dy * dy + dz * dz <= r * r;
}
