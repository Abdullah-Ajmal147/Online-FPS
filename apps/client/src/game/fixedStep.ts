import { TICK_DT } from '@sentinel/shared';

/** Longest frame we catch up on; after a long stall (tab in background) we skip, not spiral. */
export const MAX_FRAME_SECONDS = 0.25;

export interface FixedStepResult {
  /** Simulation ticks to run this frame. */
  ticks: number;
  /** Leftover time carried to the next frame. */
  accumulator: number;
  /** How far between the last two ticks to draw, 0..1. */
  alpha: number;
}

/**
 * Classic fixed-timestep accumulator: the simulation always advances in exact 1/60 s ticks,
 * whatever the display's frame rate; rendering interpolates between the last two ticks.
 */
export function advanceFixedStep(accumulator: number, frameSeconds: number): FixedStepResult {
  let acc = accumulator + Math.min(Math.max(frameSeconds, 0), MAX_FRAME_SECONDS);
  let ticks = 0;
  while (acc >= TICK_DT) {
    acc -= TICK_DT;
    ticks++;
  }
  return { ticks, accumulator: acc, alpha: acc / TICK_DT };
}
