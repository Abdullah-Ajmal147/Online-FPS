import type { EntityState } from '@sentinel/protocol';
import { TICKS_PER_SNAPSHOT, type Vec3 } from '@sentinel/shared';

/** Remote players are drawn this far in the past: 2 snapshots (~66 ms), adaptive up to 100 ms. */
export const BASE_DELAY_TICKS = 2 * TICKS_PER_SNAPSHOT;
export const MAX_DELAY_TICKS = 6;
/** Never extrapolate more than 50 ms past the newest snapshot. */
export const MAX_EXTRAPOLATION_TICKS = 3;
const KEEP_TICKS = 60;

interface Sample {
  tick: number;
  state: EntityState;
}

export interface RemotePose {
  position: Vec3;
  /** Radians. */
  yaw: number;
  crouching: boolean;
  team: number;
}

const TWO_PI = Math.PI * 2;
const yawRad = (yaw: number) => (yaw / 65536) * TWO_PI;

/** Buffers snapshots of one remote player and returns where to draw them at a given time. */
export class RemoteBuffer {
  private samples: Sample[] = [];

  push(tick: number, state: EntityState): void {
    const last = this.samples.at(-1);
    if (last && tick <= last.tick) return; // late or duplicate snapshot
    this.samples.push({ tick, state });
    while (this.samples.length > 2 && this.samples[0]!.tick < tick - KEEP_TICKS)
      this.samples.shift();
  }

  get newestTick(): number {
    return this.samples.at(-1)?.tick ?? -Infinity;
  }

  sample(renderTick: number): RemotePose | null {
    const n = this.samples.length;
    if (n === 0) return null;
    const first = this.samples[0]!;
    const last = this.samples[n - 1]!;
    if (n === 1 || renderTick <= first.tick) return pose(first.state, first.state, 0);

    if (renderTick >= last.tick) {
      // Past the newest data: extrapolate a little along the last movement, then hold.
      const prev = this.samples[n - 2]!;
      const ahead = Math.min(renderTick - last.tick, MAX_EXTRAPOLATION_TICKS);
      const t = 1 + ahead / (last.tick - prev.tick);
      return pose(prev.state, last.state, t);
    }

    let i = n - 2;
    while (i > 0 && this.samples[i]!.tick > renderTick) i--;
    const a = this.samples[i]!;
    const b = this.samples[i + 1]!;
    return pose(a.state, b.state, (renderTick - a.tick) / (b.tick - a.tick));
  }
}

function pose(a: EntityState, b: EntityState, t: number): RemotePose {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  // Shortest way round for yaw.
  let dy = yawRad(b.yaw) - yawRad(a.yaw);
  if (dy > Math.PI) dy -= TWO_PI;
  if (dy < -Math.PI) dy += TWO_PI;
  return {
    position: [
      lerp(a.position[0], b.position[0]),
      lerp(a.position[1], b.position[1]),
      lerp(a.position[2], b.position[2]),
    ],
    yaw: yawRad(a.yaw) + dy * Math.min(t, 1),
    crouching: t < 0.5 ? a.crouching : b.crouching,
    team: b.team,
  };
}

/**
 * Adaptive interpolation delay: 2 snapshots normally, more (up to 100 ms) when snapshot
 * arrival times get jittery, so we don't run out of data to interpolate.
 */
export class InterpolationDelay {
  ticks = BASE_DELAY_TICKS;
  private lastArrival = -1;
  private jitterMs = 0;

  onSnapshotArrival(nowMs: number): void {
    if (this.lastArrival >= 0) {
      const gap = nowMs - this.lastArrival;
      const expected = (TICKS_PER_SNAPSHOT * 1000) / 60;
      this.jitterMs += (Math.abs(gap - expected) - this.jitterMs) * 0.1;
    }
    this.lastArrival = nowMs;
    const wanted = BASE_DELAY_TICKS + (this.jitterMs * 2 * 60) / 1000;
    this.ticks = Math.min(MAX_DELAY_TICKS, Math.max(BASE_DELAY_TICKS, wanted));
  }
}
