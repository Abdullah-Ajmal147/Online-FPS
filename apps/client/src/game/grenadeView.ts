import { equipment } from '@sentinel/content';
import type { ProjectileState } from '@sentinel/protocol';
import type { Vec3 } from '@sentinel/shared';
import * as THREE from 'three/webgpu';

interface Tracked {
  /** Last two server samples, for interpolation like remote players. */
  a: { tick: number; position: Vec3 };
  b: { tick: number; position: Vec3 };
  kind: 'frag' | 'smoke';
  cloud: boolean;
  /** performance.now() when we first saw the cloud out. */
  cloudSince: number;
  mesh: THREE.Object3D;
}

/** Puffs per smoke cloud: overlapping soft spheres read as one opaque cloud from any side. */
const PUFFS = 16;
const SMOKE_GROW_S = 1.2;
const SMOKE_FADE_S = 2.5;

/**
 * Draws grenades in flight and smoke clouds from snapshots (the server simulates them; nothing
 * here decides anything). Positions are interpolated at the same render tick as other players.
 */
export class GrenadeView {
  private readonly tracked = new Map<number, Tracked>();
  private readonly fragGeo = new THREE.SphereGeometry(0.07, 10, 8);
  private readonly fragMat = new THREE.MeshStandardMaterial({ color: 0x3d4a2f, roughness: 0.6 });
  private readonly smokeCanGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10);
  private readonly smokeCanMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad });
  private readonly puffGeo = new THREE.SphereGeometry(1, 14, 10);

  constructor(private readonly scene: THREE.Scene) {}

  onSnapshot(serverTick: number, projectiles: ProjectileState[]): void {
    const seen = new Set<number>();
    for (const p of projectiles) {
      seen.add(p.id);
      let t = this.tracked.get(p.id);
      if (t && t.kind !== p.kind) {
        this.drop(p.id); // id reused by a new grenade
        t = undefined;
      }
      if (!t) {
        t = {
          a: { tick: serverTick, position: p.position },
          b: { tick: serverTick, position: p.position },
          kind: p.kind,
          cloud: false,
          cloudSince: 0,
          mesh:
            p.kind === 'frag'
              ? new THREE.Mesh(this.fragGeo, this.fragMat)
              : new THREE.Mesh(this.smokeCanGeo, this.smokeCanMat),
        };
        this.scene.add(t.mesh);
        this.tracked.set(p.id, t);
      } else {
        t.a = t.b;
        t.b = { tick: serverTick, position: p.position };
      }
      if (p.cloud && !t.cloud) this.releaseCloud(t);
    }
    for (const id of [...this.tracked.keys()]) if (!seen.has(id)) this.drop(id);
  }

  /** Smoke clouds as spheres (client-side vision checks: name tags, red crosshair). */
  *clouds(): Generator<{ position: Vec3; radius: number }> {
    const r = equipment.smoke.smoke!.radius;
    for (const t of this.tracked.values()) if (t.cloud) yield { position: t.b.position, radius: r };
  }

  /** True if the line a→b passes through a smoke cloud we are drawing. */
  smokeBlocks(a: Vec3, b: Vec3): boolean {
    for (const c of this.clouds()) {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c.position[0] - a[0], c.position[1] - a[1], c.position[2] - a[2]];
      const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
      const t =
        len2 === 0
          ? 0
          : Math.max(0, Math.min(1, (ac[0]! * ab[0]! + ac[1]! * ab[1]! + ac[2]! * ab[2]!) / len2));
      const d2 =
        (ab[0]! * t - ac[0]!) ** 2 + (ab[1]! * t - ac[1]!) ** 2 + (ab[2]! * t - ac[2]!) ** 2;
      if (d2 <= c.radius * c.radius) return true;
    }
    return false;
  }

  update(renderTick: number, nowMs: number): void {
    for (const t of this.tracked.values()) {
      const span = t.b.tick - t.a.tick;
      const k = span > 0 ? Math.min(1, Math.max(0, (renderTick - t.a.tick) / span)) : 1;
      const [ax, ay, az] = t.a.position;
      const [bx, by, bz] = t.b.position;
      t.mesh.position.set(ax + (bx - ax) * k, ay + (by - ay) * k, az + (bz - az) * k);
      if (!t.cloud) {
        t.mesh.rotation.x += 0.2;
        continue;
      }
      // Grow in, hold, fade out at the end of the cloud's life.
      const age = (nowMs - t.cloudSince) / 1000;
      const life = equipment.smoke.smoke!.duration;
      const grow = Math.min(1, age / SMOKE_GROW_S);
      const fade = Math.min(1, Math.max(0, (life - age) / SMOKE_FADE_S));
      const g = t.mesh as THREE.Group;
      g.scale.setScalar(0.3 + 0.7 * grow);
      for (const puff of g.children as THREE.Mesh[]) {
        (puff.material as THREE.MeshBasicMaterial).opacity = 0.9 * fade;
        puff.rotation.y += 0.002;
      }
    }
  }

  clear(): void {
    for (const id of [...this.tracked.keys()]) this.drop(id);
  }

  private releaseCloud(t: Tracked): void {
    this.scene.remove(t.mesh);
    const cloud = new THREE.Group();
    const r = equipment.smoke.smoke!.radius;
    // A fixed spiral layout: every client draws the same cloud shape.
    for (let i = 0; i < PUFFS; i++) {
      const a = i * 2.39996; // golden angle
      const rr = r * 0.55 * Math.sqrt((i + 0.5) / PUFFS);
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xb8bec6 : 0xc9ced4,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const puff = new THREE.Mesh(this.puffGeo, mat);
      const s = r * (0.45 + 0.15 * ((i * 7) % 5) * 0.25);
      puff.scale.set(s, s * 0.8, s);
      puff.position.set(Math.cos(a) * rr, s * 0.55 + (i % 4) * 0.25, Math.sin(a) * rr);
      cloud.add(puff);
    }
    t.mesh = cloud;
    t.cloud = true;
    t.cloudSince = performance.now();
    this.scene.add(cloud);
  }

  private drop(id: number): void {
    const t = this.tracked.get(id);
    if (!t) return;
    this.scene.remove(t.mesh);
    if (t.cloud) {
      for (const puff of (t.mesh as THREE.Group).children as THREE.Mesh[]) {
        (puff.material as THREE.Material).dispose();
      }
    }
    this.tracked.delete(id);
  }
}
