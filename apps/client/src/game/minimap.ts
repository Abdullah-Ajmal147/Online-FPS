import type { Solid } from '@sentinel/shared';

/**
 * The minimap (top-left): the map from above, turned so the way you face is up, you in the
 * middle. Teammates always show (blue); an enemy shows as a red dot where they fired, for a
 * few seconds (gunfire gives you away, like the big shooters); a radar sweep (kill-streak
 * reward) shows every enemy for its duration. Domination nodes in their owner's colour.
 *
 * Only what the client already knows: teammates are always in snapshots, and an enemy's shot
 * arrives with its position (ADR 0009); the sweep is its own earned event (ADR 0012).
 */

/** Metres from the centre to the edge. */
const RANGE = 36;
/** Size on screen, CSS pixels. */
const SIZE = 184;
/** A shot keeps its dot this long. */
const FIRE_DOT_MS = 2500;
/** Pre-drawn map: pixels per metre. */
const MAP_PX_PER_M = 4;

interface Dot {
  x: number;
  z: number;
  at: number;
}

export class Minimap {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);
  /** The map drawn once from above (world x → right, world z → down). */
  private mapImage: HTMLCanvasElement | null = null;
  private mapOrigin = { x: 0, z: 0 };
  private points: { id: string; x: number; z: number }[] = [];
  private fired = new Map<number, Dot>();
  private sweepDots: [number, number][] = [];
  private sweepUntil = -Infinity;
  private sweepFrom = -Infinity;

  constructor(host: Element) {
    this.el = document.createElement('canvas');
    this.el.className = 'minimap';
    this.el.dataset.testid = 'minimap';
    this.el.width = SIZE * this.dpr;
    this.el.height = SIZE * this.dpr;
    this.ctx = this.el.getContext('2d');
    host.after(this.el);
  }

  /** A new map: draw its walls and buildings from above once (taller = lighter). */
  setMap(
    solids: readonly Solid[],
    points: readonly { id: string; position: readonly number[] }[],
  ): void {
    this.points = points.map((p) => ({ id: p.id, x: p.position[0]!, z: p.position[2]! }));
    this.fired.clear();
    this.sweepUntil = -Infinity;
    const shapes = solids
      .map(footprint)
      .filter((f): f is Footprint => f !== null && f.top > 0.15)
      .sort((a, b) => a.top - b.top);
    if (shapes.length === 0) {
      this.mapImage = null;
      return;
    }
    const minX = Math.min(...shapes.map((s) => s.x0)) - 2;
    const minZ = Math.min(...shapes.map((s) => s.z0)) - 2;
    const maxX = Math.max(...shapes.map((s) => s.x1)) + 2;
    const maxZ = Math.max(...shapes.map((s) => s.z1)) + 2;
    const img = document.createElement('canvas');
    img.width = Math.ceil((maxX - minX) * MAP_PX_PER_M);
    img.height = Math.ceil((maxZ - minZ) * MAP_PX_PER_M);
    const g = img.getContext('2d');
    if (!g) return;
    for (const s of shapes) {
      // Low cover dark, walls and buildings light: the height reads at a glance.
      const k = Math.min(1, Math.max(0, (s.top - 0.4) / 3));
      const c = Math.round(70 + k * 110);
      g.fillStyle = `rgb(${c}, ${c + 6}, ${c + 10})`;
      g.fillRect(
        (s.x0 - minX) * MAP_PX_PER_M,
        (s.z0 - minZ) * MAP_PX_PER_M,
        (s.x1 - s.x0) * MAP_PX_PER_M,
        (s.z1 - s.z0) * MAP_PX_PER_M,
      );
    }
    this.mapImage = img;
    this.mapOrigin = { x: minX, z: minZ };
  }

  /** An enemy fired from here (their position in the snapshot that carried the shot). */
  enemyFired(id: number, x: number, z: number, now = performance.now()): void {
    this.fired.set(id, { x, z, at: now });
  }

  /** An enemy died or left: their dot goes. */
  forget(id: number): void {
    this.fired.delete(id);
  }

  /** Radar sweep: every enemy, as the server sent them, for `seconds`. */
  sweep(enemies: [number, number][], seconds: number, now = performance.now()): void {
    this.sweepDots = enemies;
    this.sweepFrom = now;
    this.sweepUntil = now + seconds * 1000;
  }

  get sweeping(): boolean {
    return performance.now() < this.sweepUntil;
  }

  draw(
    me: { x: number; z: number; yaw: number },
    teammates: readonly { x: number; z: number; yaw: number }[],
    points: readonly { id: string; owner: number }[],
    myTeam: number,
    visible: boolean,
    now = performance.now(),
  ): void {
    this.el.classList.toggle('on', visible);
    this.el.dataset.sweep = now < this.sweepUntil ? 'on' : 'off';
    const g = this.ctx;
    if (!visible || !g) return;
    const px = (SIZE * this.dpr) / 2;
    const r = px - 3 * this.dpr;
    const scale = r / RANGE;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.el.width, this.el.height);
    g.save();
    g.beginPath();
    g.arc(px, px, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(12, 17, 15, 0.78)';
    g.fill();
    g.clip();

    // The world, turned so our facing is up (see radarPoint for the maths).
    g.translate(px, px);
    g.rotate(me.yaw);
    g.scale(scale, scale);
    g.translate(-me.x, -me.z);
    if (this.mapImage) {
      g.imageSmoothingEnabled = true;
      g.drawImage(
        this.mapImage,
        this.mapOrigin.x,
        this.mapOrigin.z,
        this.mapImage.width / MAP_PX_PER_M,
        this.mapImage.height / MAP_PX_PER_M,
      );
    }
    // Objectives: letters in the owner's colour.
    for (const p of this.points) {
      const owner = points.find((q) => q.id === p.id)?.owner ?? -1;
      const colour = owner < 0 ? '#e6edf3' : owner === myTeam ? '#3b8cff' : '#ff4d4d';
      g.beginPath();
      g.arc(p.x, p.z, 2.6, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fill();
      g.lineWidth = 0.5;
      g.strokeStyle = colour;
      g.stroke();
      g.save();
      g.translate(p.x, p.z);
      g.rotate(-me.yaw); // letters stay upright
      g.fillStyle = colour;
      g.font = `bold 3.4px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(p.id, 0, 0.2);
      g.restore();
    }
    // Teammates: blue arrows facing where they look.
    for (const t of teammates) arrow(g, t.x, t.z, t.yaw, '#3b8cff', 1.9);
    // Enemies: where they fired (fading), and the radar sweep.
    const dot = (x: number, z: number, alpha: number) => {
      g.globalAlpha = alpha;
      g.beginPath();
      g.arc(x, z, 1.5, 0, Math.PI * 2);
      g.fillStyle = '#ff3b30';
      g.fill();
      g.globalAlpha = 1;
    };
    for (const [id, d] of this.fired) {
      const age = (now - d.at) / FIRE_DOT_MS;
      if (age >= 1) this.fired.delete(id);
      else dot(d.x, d.z, age < 0.6 ? 1 : (1 - age) / 0.4);
    }
    if (now < this.sweepUntil) {
      const t = (now - this.sweepFrom) / (this.sweepUntil - this.sweepFrom);
      for (const [x, z] of this.sweepDots) dot(x, z, t > 0.8 ? (1 - t) / 0.2 : 1);
    }
    g.restore();

    // Sweep ring while a radar is up.
    if (now < this.sweepUntil) {
      const a = (now / 700) % (Math.PI * 2);
      g.strokeStyle = 'rgba(90, 220, 150, 0.8)';
      g.lineWidth = 1.5 * this.dpr;
      g.beginPath();
      g.moveTo(px, px);
      g.lineTo(px + Math.cos(a) * r, px + Math.sin(a) * r);
      g.stroke();
    }
    // Us: white arrow in the middle, always pointing up.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(px, px);
    g.scale(this.dpr, this.dpr);
    arrow(g, 0, 0, 0, '#ffffff', 7);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineWidth = 1.5 * this.dpr;
    g.strokeStyle = 'rgba(230, 237, 243, 0.35)';
    g.beginPath();
    g.arc(px, px, r, 0, Math.PI * 2);
    g.stroke();
  }
}

/** An arrow at (x, y) pointing along a view yaw (0 = -Z = up), `size` in drawing units. */
function arrow(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  yaw: number,
  colour: string,
  size: number,
): void {
  g.save();
  g.translate(x, y);
  g.rotate(-yaw);
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.7, size * 0.8);
  g.lineTo(0, size * 0.35);
  g.lineTo(-size * 0.7, size * 0.8);
  g.closePath();
  g.fillStyle = colour;
  g.fill();
  g.restore();
}

interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  top: number;
}

/** A solid's outline from above and its top height (boxes turn in quarter steps only). */
export function footprint(s: Solid): Footprint | null {
  if (s.shape === 'box') {
    // A quarter turn about Y swaps the X and Z extents (rotation.y = ±sin 45°).
    const turned = Math.abs(Math.abs(s.rotation[1]) - Math.SQRT1_2) < 1e-3;
    const hx = turned ? s.halfExtents[2] : s.halfExtents[0];
    const hz = turned ? s.halfExtents[0] : s.halfExtents[2];
    return {
      x0: s.center[0] - hx,
      x1: s.center[0] + hx,
      z0: s.center[2] - hz,
      z1: s.center[2] + hz,
      top: s.center[1] + s.halfExtents[1],
    };
  }
  if (s.points.length === 0) return null;
  const xs = s.points.map((p) => p[0]);
  const zs = s.points.map((p) => p[2]);
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    z0: Math.min(...zs),
    z1: Math.max(...zs),
    top: Math.max(...s.points.map((p) => p[1])),
  };
}

/**
 * World offset (dx, dz) to minimap units (right, down) for a view yaw: ahead is up.
 * Yaw 0 faces -Z; turning left increases yaw. This is the rotation `draw` applies to the map.
 */
export function radarPoint(dx: number, dz: number, yaw: number, scale: number): [number, number] {
  const ahead = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  return [right * scale, -ahead * scale];
}
