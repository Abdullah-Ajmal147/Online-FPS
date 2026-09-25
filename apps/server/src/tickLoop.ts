import { TICK_DT } from '@sentinel/shared';

const TICK_MS = TICK_DT * 1000;
/** After a long stall (GC, debugger) run at most this many catch-up ticks, then drop the rest. */
export const MAX_CATCH_UP_TICKS = 5;

/**
 * Fixed 60 Hz loop driven by wall-clock time. Node timers drift and fire late, so we never
 * assume "one timer = one tick": elapsed time goes into an accumulator and we run however many
 * whole ticks fit. The timer itself fires twice per tick to keep lateness under ~8 ms.
 */
export class TickLoop {
  private accumulatorMs = 0;
  private last: number;

  constructor(
    private readonly onTick: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.last = now();
  }

  /** Call often (every few ms). Returns how many ticks ran. */
  pump(): number {
    const t = this.now();
    this.accumulatorMs += t - this.last;
    this.last = t;
    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_CATCH_UP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      this.onTick();
      ticks++;
    }
    if (ticks === MAX_CATCH_UP_TICKS) this.accumulatorMs = Math.min(this.accumulatorMs, TICK_MS);
    return ticks;
  }
}

export const PUMP_INTERVAL_MS = TICK_MS / 2;
