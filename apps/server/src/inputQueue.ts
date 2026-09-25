import { Button, type PlayerInput } from '@sentinel/shared';

/** What the server simulates for one tick: the input plus the tick the client was viewing. */
export interface TickInput extends PlayerInput {
  viewTick: number;
}
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

/** How long we keep repeating a silent client's last input before letting them stand still. */
export const MAX_REPEAT_TICKS = 15; // 250 ms: rides out jitter, stops a tabbed-out player running forever
/**
 * Buttons whose press (not hold) matters. When stale inputs are dropped, these are carried into
 * the next input so a jump, slide, shot or reload press is never lost.
 */
const PRESS_BUTTONS = Button.Jump | Button.Crouch | Button.Fire | Button.Reload;

/**
 * Guessed (starved) ticks: a held trigger is kept for at most this many ticks (50 ms), which
 * covers ordinary jitter gaps so honest automatic fire isn't lost, while limiting a trigger
 * released right at a gap to at most one extra round (600 rpm = one shot per 6 ticks).
 * Reload is never guessed.
 */
export const GUESS_FIRE_TICKS = 3;

const IDLE: TickInput = { buttons: 0, yaw: 0, pitch: 0, viewTick: 0 };

/**
 * Per-player input queue on the server (docs/NETCODE.md, "Message flow").
 *
 * The server advances every player exactly ONE step per tick, never more:
 *   - the next input in seq order if one is queued, or
 *   - a repeat of the last input's buttons if none arrived in time (never a position from the client),
 *     for at most MAX_REPEAT_TICKS; after that the player stands still (same view angles).
 * So a client can't move faster by sending more inputs: extras are dropped by the cap.
 * Each input carries the previous two as well (redundancy), so duplicates are normal and ignored.
 *
 * Catching up after a stall: every tick we had to guess is "debt". When the late inputs arrive
 * we drop that many of the oldest ones (keeping their presses), because those ticks were
 * already simulated with the guess. Without this a 250 ms hitch would be simulated twice and
 * leave the queue ~15 inputs deep, adding ~200 ms of input lag for seconds.
 */
export class InputQueue {
  lastProcessedSeq = 0;
  private lastInput: TickInput = IDLE;
  private pending: SequencedInput[] = []; // sorted by seq, all > lastProcessedSeq
  private started = false;
  /** Ticks simulated with a guessed (repeated/idle) input since the last real one. */
  private debt = 0;

  get depth(): number {
    return this.pending.length;
  }

  push(input: SequencedInput): void {
    const { seq } = input;
    if (!Number.isInteger(seq) || seq > 0xffffffff || seq <= this.lastProcessedSeq) return; // old/resent/invalid
    // The first inputs set the baseline (a client may have counted seqs offline before joining).
    // After that, a huge jump is garbage.
    if (this.lastProcessedSeq > 0 && seq > this.lastProcessedSeq + MAX_SEQ_JUMP) return;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1]!.seq > seq) i--;
    if (i > 0 && this.pending[i - 1]!.seq === seq) return; // duplicate
    this.pending.splice(i, 0, input);
    // Too far behind (burst after a stall, or flooding): drop the oldest so latency stays bounded.
    while (this.pending.length > MAX_QUEUED_INPUTS) this.pending.shift();
  }

  /**
   * The input for this tick, or null while a new player's start buffer is still filling
   * (the player is not simulated yet, so the client's first predicted step matches ours).
   * Once started, it always returns an input: the server never skips a player's step.
   */
  next(): TickInput | null {
    if (!this.started) {
      if (this.pending.length < START_BUFFER) return null;
      this.started = true;
    }
    if (this.pending.length === 0) {
      // Starved: repeat the last input for a short while, then stand still.
      this.debt++;
      // A guessed tick: the client's view moved on by one tick too.
      const viewTick = this.lastInput.viewTick + this.debt;
      // Keep moving and looking; keep a held trigger only briefly; never reload on a guess.
      if (this.debt <= MAX_REPEAT_TICKS) {
        const forbidden = Button.Reload | (this.debt > GUESS_FIRE_TICKS ? Button.Fire : 0);
        return { ...this.lastInput, buttons: this.lastInput.buttons & ~forbidden, viewTick };
      }
      const { yaw, pitch, weaponSlot } = this.lastInput;
      return {
        buttons: IDLE.buttons,
        yaw,
        pitch,
        viewTick,
        ...(weaponSlot === undefined ? {} : { weaponSlot }),
      };
    }
    // Pay back debt: skip inputs for ticks we already simulated with a guess (keep one to apply).
    let carried = 0;
    while (this.debt > 0 && this.pending.length > 1) {
      carried |= this.pending.shift()!.buttons & PRESS_BUTTONS;
      this.debt--;
    }
    this.debt = 0;
    const input = this.pending.shift()!;
    this.lastProcessedSeq = input.seq;
    this.lastInput = {
      buttons: input.buttons | carried,
      yaw: input.yaw,
      pitch: input.pitch,
      weaponSlot: input.weaponSlot,
      viewTick: input.viewTick,
    };
    return this.lastInput;
  }
}
