import type { Movement } from '@sentinel/content';
import {
  SKIN,
  groundHeightBelow,
  type PhysicsWorld,
  type Rapier,
  type Vec3,
} from '@sentinel/shared';

/**
 * Navigation grid for server bots (ADR 0007): 1 m cells over the map, built from the same
 * physics world the game uses. A cell is walkable if there is ground under it and room to stand
 * on it. Two neighbouring cells connect if the ground between them never jumps more than the
 * step height (so stairs and ramps connect, ledges don't). Single-level maps only.
 */
export class NavGrid {
  readonly cell = 1;
  readonly minX: number;
  readonly minZ: number;
  readonly w: number;
  readonly h: number;
  /** Ground height per cell, NaN if not walkable. */
  readonly height: Float32Array;
  /** Bitmask of connected neighbours (8 directions) per cell. */
  readonly links: Uint8Array;

  static readonly DIRS: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  constructor(
    rapier: Rapier,
    world: PhysicsWorld,
    tuning: Movement,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ) {
    this.minX = Math.floor(bounds.minX);
    this.minZ = Math.floor(bounds.minZ);
    this.w = Math.ceil(bounds.maxX) - this.minX;
    this.h = Math.ceil(bounds.maxZ) - this.minZ;
    this.height = new Float32Array(this.w * this.h).fill(Number.NaN);
    this.links = new Uint8Array(this.w * this.h);

    const ground = (x: number, z: number) => groundHeightBelow(rapier, world, [x, 60, z], 120);
    const r = tuning.capsuleRadius;
    const standing = new rapier.Capsule(tuning.standingHeight / 2 - r, r * 0.9);
    const identity = { x: 0, y: 0, z: 0, w: 1 };

    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const [x, z] = this.center(i, j);
        const y = ground(x, z);
        if (y === null || y < -5) continue;
        // Room to stand: a slightly slimmer standing capsule must not overlap anything.
        const blocked = world.intersectionWithShape(
          { x, y: y + SKIN + 0.05 + tuning.standingHeight / 2, z },
          identity,
          standing,
          rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        );
        if (!blocked) this.height[j * this.w + i] = y;
      }
    }

    // Connect neighbours whose ground is continuous (no step taller than stepHeight + margin).
    const maxStep = tuning.stepHeight + 0.05;
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const a = this.height[j * this.w + i]!;
        if (Number.isNaN(a)) continue;
        NavGrid.DIRS.forEach(([di, dj], bit) => {
          const ni = i + di;
          const nj = j + dj;
          if (!this.walkable(ni, nj)) return;
          // No cutting corners on diagonals.
          if (di !== 0 && dj !== 0 && (!this.walkable(i + di, j) || !this.walkable(i, j + dj)))
            return;
          const [x0, z0] = this.center(i, j);
          const [x1, z1] = this.center(ni, nj);
          let prev = a;
          for (const t of [0.25, 0.5, 0.75, 1]) {
            const y =
              t === 1
                ? this.height[nj * this.w + ni]!
                : ground(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
            if (y === null || Math.abs(y - prev) > maxStep) return;
            prev = y;
          }
          this.links[j * this.w + i]! |= 1 << bit;
        });
      }
    }
    this.labelRegions();
  }

  /** Connected region id per cell (-1 = not walkable); region 0.. by flood fill. */
  private region!: Int32Array;
  /** The biggest region: the playable floor (rooftops and crate tops are small islands). */
  private mainRegion = -1;

  private labelRegions(): void {
    this.region = new Int32Array(this.w * this.h).fill(-1);
    let next = 0;
    let bestSize = 0;
    const stack: number[] = [];
    for (let c = 0; c < this.w * this.h; c++) {
      if (this.region[c] !== -1 || Number.isNaN(this.height[c]!)) continue;
      let size = 0;
      this.region[c] = next;
      stack.push(c);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        size++;
        const ci = cur % this.w;
        const cj = Math.floor(cur / this.w);
        for (let bit = 0; bit < 8; bit++) {
          if (!(this.links[cur]! & (1 << bit))) continue;
          const [di, dj] = NavGrid.DIRS[bit]!;
          const n = (cj + dj) * this.w + ci + di;
          if (this.region[n] === -1) {
            this.region[n] = next;
            stack.push(n);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        this.mainRegion = next;
      }
      next++;
    }
  }

  /** True if walking from one cell to the other is possible at all. */
  connected(a: [number, number], b: [number, number]): boolean {
    const ra = this.region[a[1] * this.w + a[0]];
    return ra !== undefined && ra !== -1 && ra === this.region[b[1] * this.w + b[0]];
  }

  center(i: number, j: number): [number, number] {
    return [this.minX + (i + 0.5) * this.cell, this.minZ + (j + 0.5) * this.cell];
  }

  cellOf(x: number, z: number): [number, number] {
    return [Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell)];
  }

  walkable(i: number, j: number): boolean {
    return (
      i >= 0 && j >= 0 && i < this.w && j < this.h && !Number.isNaN(this.height[j * this.w + i]!)
    );
  }

  /** Nearest walkable cell to a position (searching outwards a few cells). */
  nearestWalkable(x: number, z: number): [number, number] | null {
    const [ci, cj] = this.cellOf(x, z);
    for (let r = 0; r <= 4; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          if (this.walkable(ci + di, cj + dj)) return [ci + di, cj + dj];
        }
      }
    }
    return null;
  }

  /** All walkable cells (for picking roam goals). */
  /**
   * Cells worth walking to: the main connected floor only (not rooftops or crate tops, which
   * can't be reached on foot). Computed once; the grid never changes.
   */
  walkableCells(): readonly [number, number][] {
    if (!this.cellsCache) {
      const out: [number, number][] = [];
      for (let j = 0; j < this.h; j++)
        for (let i = 0; i < this.w; i++) {
          if (this.region[j * this.w + i] === this.mainRegion) out.push([i, j]);
        }
      this.cellsCache = out;
    }
    return this.cellsCache;
  }

  private cellsCache: [number, number][] | null = null;
  /** A* scratch buffers, reused across searches (no per-path allocation). */
  private scratch: { g: Float32Array; came: Int32Array; closed: Uint8Array } | null = null;

  /**
   * A* over the grid (octile distance). Returns world-space waypoints (cell centres at ground
   * height) from start to goal, or null if unreachable.
   */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const start = this.nearestWalkable(from[0], from[2]);
    const goal = this.nearestWalkable(to[0], to[2]);
    if (!start || !goal) return null;
    // Different regions: unreachable. Answer at once instead of searching the whole map.
    if (!this.connected(start, goal)) return null;
    const idx = (i: number, j: number) => j * this.w + i;
    const startI = idx(...start);
    const goalI = idx(...goal);
    this.scratch ??= {
      g: new Float32Array(this.w * this.h),
      came: new Int32Array(this.w * this.h),
      closed: new Uint8Array(this.w * this.h),
    };
    const { g, came, closed } = this.scratch;
    g.fill(Infinity);
    came.fill(-1);
    closed.fill(0);
    const open = new MinHeap();
    const hCost = (i: number) => {
      const dx = Math.abs((i % this.w) - goal[0]);
      const dz = Math.abs(Math.floor(i / this.w) - goal[1]);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    g[startI] = 0;
    open.push(startI, hCost(startI));
    while (open.size > 0) {
      const cur = open.pop();
      if (cur === goalI) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % this.w;
      const cj = Math.floor(cur / this.w);
      const links = this.links[cur]!;
      for (let bit = 0; bit < 8; bit++) {
        if (!(links & (1 << bit))) continue;
        const [di, dj] = NavGrid.DIRS[bit]!;
        const n = idx(ci + di, cj + dj);
        const cost = g[cur]! + (di !== 0 && dj !== 0 ? Math.SQRT2 : 1);
        if (cost < g[n]!) {
          g[n] = cost;
          came[n] = cur;
          open.push(n, cost + hCost(n));
        }
      }
    }
    if (startI !== goalI && came[goalI] === -1) return null;
    const cells: number[] = [];
    for (let c = goalI; c !== -1 && c !== startI; c = came[c]!) cells.push(c);
    cells.reverse();
    return cells.map((c) => {
      const [x, z] = this.center(c % this.w, Math.floor(c / this.w));
      return [x, this.height[c]!, z] as Vec3;
    });
  }
}

/** Minimal binary heap keyed by priority, for A*. */
class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.prio.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p]! <= this.prio[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    const lastItem = this.items.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l]! < this.prio[m]!) m = l;
        if (r < this.items.length && this.prio[r]! < this.prio[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
  }
}
