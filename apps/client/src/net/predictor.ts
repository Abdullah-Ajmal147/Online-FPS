import type { OwnState, SequencedInput } from '@sentinel/protocol';
import {
  INPUT_REDUNDANCY,
  step,
  type MovementContext,
  type PlayerBody,
  type PlayerState,
  type Vec3,
} from '@sentinel/shared';

/** History kept for replay: 2 s of ticks covers any ping we still consider playable. */
const HISTORY = 120;
/** Errors below this are blended out visually; larger ones snap (docs/NETCODE.md). */
export const BLEND_BELOW_METRES = 0.05;
export const BLEND_SECONDS = 0.1;

interface Entry {
  seq: number;
  input: SequencedInput;
  /** State after applying this input. */
  state: PlayerState;
}

export interface PredictionStats {
  /** Snapshots that carried our own state. */
  snapshots: number;
  /** Snapshots after which our predicted position moved (a correction). */
  corrections: number;
  /** Size of the last correction, metres. */
  lastError: number;
}

/**
 * Client-side prediction + reconciliation (docs/NETCODE.md).
 *
 * Every local tick we apply our input immediately with the same step() the server runs and
 * remember (input, resulting state). When a snapshot says "I have processed up to seq N and
 * your state is S", we restart from S and replay every input after N. If the server saw the
 * same inputs we did, the replay lands exactly where we already were: no correction. Otherwise
 * the difference is either blended out over 100 ms (small) or snapped (large).
 */
export class Predictor {
  state: PlayerState;
  /** Visual-only offset added to the rendered position while a small correction blends out. */
  readonly renderOffset: [number, number, number] = [0, 0, 0];
  readonly stats: PredictionStats = { snapshots: 0, corrections: 0, lastError: 0 };
  private seq = 0;
  private history: Entry[] = [];

  constructor(
    initial: PlayerState,
    private readonly ctx: MovementContext,
    private readonly body: PlayerBody,
  ) {
    this.state = initial;
  }

  /** Apply one local input. Returns the sequenced input to send. */
  tick(input: Omit<SequencedInput, 'seq'>): SequencedInput {
    const sequenced: SequencedInput = { ...input, seq: ++this.seq };
    this.state = step(this.state, sequenced, this.ctx, this.body);
    this.history.push({ seq: sequenced.seq, input: sequenced, state: this.state });
    if (this.history.length > HISTORY) this.history.shift();
    return sequenced;
  }

  /** The newest inputs, oldest first, to put in the next InputCmd (redundancy against loss). */
  recentInputs(): SequencedInput[] {
    return this.history.slice(-INPUT_REDUNDANCY).map((e) => e.input);
  }

  /** Reconcile with the server's authoritative state for our player. */
  onServerState(own: OwnState, lastProcessedSeq: number): void {
    this.stats.snapshots++;
    // Drop what the server has already processed; keep the entry for lastProcessedSeq itself.
    while (this.history.length > 0 && this.history[0]!.seq < lastProcessedSeq) this.history.shift();
    const acked = this.history[0]?.seq === lastProcessedSeq ? this.history.shift() : undefined;

    // Fast path: the server agrees exactly with what we predicted for that input.
    if (acked && sameState(acked.state, own)) return;

    // Rebuild from the server's state and replay everything the server hasn't processed yet.
    const before: Vec3 = this.state.position;
    const base = this.history[0]?.input ?? acked?.input;
    let s: PlayerState = {
      ...own,
      yaw: acked?.input.yaw ?? base?.yaw ?? this.state.yaw,
      pitch: acked?.input.pitch ?? base?.pitch ?? this.state.pitch,
    };
    for (const e of this.history) {
      s = step(s, e.input, this.ctx, this.body);
      e.state = s;
    }
    this.state = s;

    const dx = before[0] - s.position[0];
    const dy = before[1] - s.position[1];
    const dz = before[2] - s.position[2];
    const error = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.stats.lastError = error;
    if (error === 0) return;
    this.stats.corrections++;
    if (error < BLEND_BELOW_METRES) {
      // Keep drawing where we were and let the offset decay to zero.
      this.renderOffset[0] += dx;
      this.renderOffset[1] += dy;
      this.renderOffset[2] += dz;
    } else {
      this.renderOffset.fill(0);
    }
  }

  /** Decay the visual correction offset; call once per rendered frame. */
  decayOffset(frameSeconds: number): void {
    const k = Math.max(0, 1 - frameSeconds / BLEND_SECONDS);
    for (let i = 0; i < 3; i++) this.renderOffset[i] = this.renderOffset[i]! * k;
  }
}

function sameState(a: PlayerState, b: OwnState): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.velocity[0] === b.velocity[0] &&
    a.velocity[1] === b.velocity[1] &&
    a.velocity[2] === b.velocity[2] &&
    a.grounded === b.grounded &&
    a.crouching === b.crouching &&
    a.slideTicks === b.slideTicks &&
    a.slideCooldownTicks === b.slideCooldownTicks &&
    a.prevButtons === b.prevButtons
  );
}
