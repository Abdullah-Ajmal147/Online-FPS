import { TICK_DT } from '@sentinel/shared';

/**
 * Toggle sprint, with double taps for tactical sprint. The simulation only sees the Sprint bit
 * and starts a tactical sprint on two rising edges within the double-tap window, so:
 * - not sprinting: a press latches sprint on (first edge);
 * - sprinting: every press sends one tick without Sprint (a "blip"), so the sim sees an edge.
 *   Two presses within the window are a double tap (sprint stays on); a single press turns
 *   sprint off once the window has passed without a second one.
 * The window here is one tick shorter than the sim's, so a tap the client counts as a double
 * tap never lands just outside the sim's window.
 */
export class SprintToggle {
  latched = false;
  private blip = false;
  private lastPress = -Infinity;
  /** Time (ms) of a single press that will turn sprint off if no second press follows. */
  private pendingOff: number | null = null;
  private readonly windowMs: number;

  constructor(doubleTapWindowSeconds: number) {
    this.windowMs = (doubleTapWindowSeconds - TICK_DT) * 1000;
  }

  press(nowMs: number): void {
    if (!this.latched) {
      this.latched = true;
    } else {
      this.blip = true;
      if (nowMs - this.lastPress < this.windowMs)
        this.pendingOff = null; // double tap
      else this.pendingOff = nowMs;
    }
    this.lastPress = nowMs;
  }

  /** The Sprint bit for the next tick. */
  sample(nowMs: number): boolean {
    if (this.pendingOff !== null && nowMs - this.pendingOff >= this.windowMs) {
      this.latched = false;
      this.pendingOff = null;
    }
    if (this.blip) {
      this.blip = false;
      return false;
    }
    return this.latched;
  }

  reset(): void {
    this.latched = false;
    this.blip = false;
    this.pendingOff = null;
    this.lastPress = -Infinity;
  }
}
