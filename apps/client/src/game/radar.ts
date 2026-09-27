/**
 * Radar sweep (kill-streak reward): a round radar in the top-left corner showing where the
 * enemies were when a teammate earned it. You are in the middle, facing up; the dots don't
 * move (it's a snapshot, not a live track) and the radar fades out when the sweep ends.
 */
export class Radar {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private enemies: [number, number][] = [];
  private shownAt = -Infinity;
  private durationMs = 0;

  constructor(
    host: Element,
    /** Metres from the centre to the edge of the radar. */
    private readonly range = 45,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'radar';
    this.el.dataset.testid = 'radar';
    this.el.width = 168;
    this.el.height = 168;
    this.ctx = this.el.getContext('2d');
    host.after(this.el);
  }

  show(enemies: [number, number][], seconds: number, now = performance.now()): void {
    this.enemies = enemies;
    this.shownAt = now;
    this.durationMs = seconds * 1000;
  }

  get active(): boolean {
    return performance.now() - this.shownAt < this.durationMs;
  }

  /** Draw for our position and view yaw (radians, 0 = facing -Z, increasing turns left). */
  update(x: number, z: number, yaw: number, now = performance.now()): void {
    const t = (now - this.shownAt) / this.durationMs;
    const on = t >= 0 && t < 1;
    this.el.classList.toggle('on', on);
    const g = this.ctx;
    if (!on || !g) return;
    const size = this.el.width;
    const r = size / 2 - 4;
    const c = size / 2;
    g.clearRect(0, 0, size, size);
    g.globalAlpha = t > 0.8 ? (1 - t) / 0.2 : 1;
    // Disc, rings and the sweep line.
    g.fillStyle = 'rgba(8, 20, 14, 0.72)';
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(90, 220, 150, 0.35)';
    g.lineWidth = 1;
    for (const k of [1, 0.66, 0.33]) {
      g.beginPath();
      g.arc(c, c, r * k, 0, Math.PI * 2);
      g.stroke();
    }
    const sweep = (now / 700) % (Math.PI * 2);
    g.strokeStyle = 'rgba(90, 220, 150, 0.7)';
    g.beginPath();
    g.moveTo(c, c);
    g.lineTo(c + Math.cos(sweep) * r, c + Math.sin(sweep) * r);
    g.stroke();
    // Us: a small arrow pointing up.
    g.fillStyle = '#e6edf3';
    g.beginPath();
    g.moveTo(c, c - 6);
    g.lineTo(c - 4, c + 4);
    g.lineTo(c + 4, c + 4);
    g.closePath();
    g.fill();
    // Enemies, turned into our view: "ahead" is up on the radar.
    g.fillStyle = '#ff4d4d';
    for (const [ex, ez] of this.enemies) {
      const [sx, sy] = radarPoint(ex - x, ez - z, yaw, r / this.range);
      const d = Math.hypot(sx, sy);
      const k = d > r - 5 ? (r - 5) / d : 1; // off the edge: pinned to the rim
      g.beginPath();
      g.arc(c + sx * k, c + sy * k, 4.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
}

/**
 * World offset (dx, dz) to radar pixels (right, down) for a view yaw: ahead is up.
 * Yaw 0 faces -Z; turning left increases yaw. Exported for tests.
 */
export function radarPoint(dx: number, dz: number, yaw: number, scale: number): [number, number] {
  // Forward = (-sin, -cos), right = (cos, -sin) in (x, z).
  const ahead = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  return [right * scale, -ahead * scale];
}
