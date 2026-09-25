import { TICK_RATE } from '@sentinel/shared';

/**
 * Estimates the server's current tick from snapshot arrivals. Each snapshot tells us
 * "server was at tick T" (a little in the past because of latency); we keep a smoothed offset
 * between our clock and server ticks so the estimate advances smoothly between snapshots.
 */
export class ServerClock {
  private offsetTicks: number | null = null;

  onSnapshot(serverTick: number, nowMs: number): void {
    const target = serverTick - (nowMs * TICK_RATE) / 1000;
    if (this.offsetTicks === null || Math.abs(target - this.offsetTicks) > 10) {
      this.offsetTicks = target; // first sample or a big jump (tab was asleep): snap
    } else {
      this.offsetTicks += (target - this.offsetTicks) * 0.05;
    }
  }

  /** Estimated server tick now (fractional), or null before the first snapshot. */
  now(nowMs: number): number | null {
    return this.offsetTicks === null ? null : this.offsetTicks + (nowMs * TICK_RATE) / 1000;
  }
}

/**
 * Pace our input production to keep ~2 inputs waiting in the server's queue: enough to ride
 * out jitter, not so many that they add lag. Returns a time scale for the local fixed-step loop.
 */
export const TARGET_QUEUE_DEPTH = 2;

export function inputPacing(smoothedDepth: number): number {
  const scale = 1 + (TARGET_QUEUE_DEPTH - smoothedDepth) * 0.02;
  return Math.min(1.05, Math.max(0.95, scale));
}
