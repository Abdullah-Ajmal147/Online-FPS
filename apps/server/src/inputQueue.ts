import type { PlayerInput } from '@sentinel/shared';
import type { SequencedInput } from '@sentinel/protocol';

/**
 * Most inputs we hold per player (≈333 ms). A client catching up after a frame hitch may send
 * up to 15 ticks at once (its loop caps catch-up at 0.25 s) on top of the ~2 normally queued,
 * so the cap must be above 17; dropping them would force corrections.
 * Flooding still gains nothing: the server takes one input per tick.
 */
export const MAX_QUEUED_INPUTS = 20;
/** Inputs to collect before a new player starts consuming them: absorbs network jitter. */
export const START_BUFFER = 2;
/** A seq this far beyond the last processed one is garbage, not a real input. */
const MAX_SEQ_JUMP = 600;

const IDLE: PlayerInput = { buttons: 0, yaw: 0, pitch: 0 };

/**
 * Per-player input queue on the server (docs/NETCODE.md, "Message flow").
 *
 * The server advances every player exactly ONE step per tick, never more:
 *   - the next input in seq order if one is queued, or
 *   - a repeat of the last input's buttons if none arrived in time (never a position from the client).
 * So a client can't move faster by sending more inputs: extras are dropped by the cap.
 * Each input carries the previous two as well (redundancy), so duplicates are normal and ignored.
 */
export class InputQueue {
  lastProcessedSeq = 0;
  private lastInput: PlayerInput = IDLE;
  private pending: SequencedInput[] = []; // sorted by seq, all > lastProcessedSeq
  private started = false;

  get depth(): number {
    return this.pending.length;
  }

  push(input: SequencedInput): void {
    const { seq } = input;
    if (!Number.isInteger(seq) || seq <= this.lastProcessedSeq) return; // old or resent
    if (seq > this.lastProcessedSeq + MAX_SEQ_JUMP) return;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1]!.seq > seq) i--;
    if (i > 0 && this.pending[i - 1]!.seq === seq) return; // duplicate
    this.pending.splice(i, 0, input);
    // Too far behind (burst after a stall, or flooding): drop the oldest so latency stays bounded.
    while (this.pending.length > MAX_QUEUED_INPUTS) this.pending.shift();
  }

  /** The input for this tick. Always returns something: the server never skips a player's step. */
  next(): PlayerInput {
    if (!this.started) {
      if (this.pending.length < START_BUFFER) return this.lastInput;
      this.started = true;
    }
    const input = this.pending.shift();
    if (!input) return this.lastInput; // starved: repeat the last buttons and angles
    this.lastProcessedSeq = input.seq;
    this.lastInput = { buttons: input.buttons, yaw: input.yaw, pitch: input.pitch };
    return this.lastInput;
  }
}
