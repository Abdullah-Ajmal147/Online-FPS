import { stepSim, type SimContext, type SimState } from '../combat/sim.ts';
import type { ShotRequest, WeaponState } from '../combat/weapon.ts';
import { INPUT_REDUNDANCY } from '../constants.ts';
import type { PlayerInput } from '../input.ts';
import type { Vec3 } from '../map/solids.ts';
import type { PlayerBody } from '../movement/context.ts';
import type { PlayerState } from '../movement/state.ts';

/** History kept for replay: 2 s of ticks covers any ping we still consider playable. */
const HISTORY = 120;
/** Errors below this are blended out visually; larger ones snap (docs/NETCODE.md). */
export const BLEND_BELOW_METRES = 0.05;
export const BLEND_SECONDS = 0.1;

/** An input with its sequence number, as sent in InputCmd (see packages/protocol). */
export interface SequencedInput extends PlayerInput {
  seq: number;
  weaponSlot: number;
  /**
   * Server tick (fractional) at which this client was drawing the other players when the input
   * was made. The server rewinds hitboxes to it for lag compensation (ADR 0005).
   */
  viewTick: number;
}

/** Everything the simulation reads, as the server sends it for our own player (ADR 0003). */
export interface OwnState {
  move: Omit<PlayerState, 'yaw' | 'pitch'>;
  weapon: WeaponState;
}

interface Entry {
  seq: number;
  input: SequencedInput;
  /** State after applying this input. */
  state: SimState;
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
 * Every local tick we apply our input immediately with the same stepSim() the server runs and
 * remember (input, resulting state). When a snapshot says "I have processed up to seq N and
 * your state is S", we restart from S and replay every input after N. If the server saw the
 * same inputs we did, the replay lands exactly where we already were: no correction. Otherwise
 * the difference is either blended out over 100 ms (small) or snapped (large).
 * Weapon state (ammo, reload, recoil) is predicted and reconciled the same way.
 */
export class Predictor {
  state: SimState;
  /** Visual-only offset added to the rendered position while a small correction blends out. */
  readonly renderOffset: [number, number, number] = [0, 0, 0];
  readonly stats: PredictionStats = { snapshots: 0, corrections: 0, lastError: 0 };
  private seq = 0;
  private history: Entry[] = [];

  constructor(
    initial: SimState,
    private readonly ctx: SimContext,
    private readonly body: PlayerBody,
  ) {
    this.state = initial;
  }

  /**
   * Start over from a state the server gave us.
   * - Joining (`replayAfterSeq` omitted): drop all history. Inputs predicted offline must never
   *   be replayed; the server takes our first seq as its baseline.
   * - Respawning: the server already applied `lastProcessedSeq`; inputs after it are still in
   *   flight and WILL be applied on top of this state, so replay them here too.
   */
  reset(state: SimState, replayAfterSeq?: number): void {
    this.renderOffset.fill(0);
    if (replayAfterSeq === undefined) {
      this.state = state;
      this.history = [];
      return;
    }
    this.history = this.history.filter((e) => e.seq > replayAfterSeq);
    let s = state;
    for (const e of this.history) {
      s = stepSim(s, e.input, this.ctx, this.body).state;
      e.state = s;
    }
    this.state = s;
  }

  /**
   * Apply one local input. Returns the sequenced input to send and the shot it fired, if any
   * (for muzzle flash, tracer and predicted hit marker; the server decides the real hit).
   * Replays during reconciliation never report shots, so effects never play twice.
   */
  tick(input: Omit<SequencedInput, 'seq'>): { sent: SequencedInput; shot: ShotRequest | null } {
    const sent: SequencedInput = { ...input, seq: ++this.seq };
    const r = stepSim(this.state, sent, this.ctx, this.body);
    this.state = r.state;
    this.history.push({ seq: sent.seq, input: sent, state: this.state });
    if (this.history.length > HISTORY) this.history.shift();
    return { sent, shot: r.shot };
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
    const before: Vec3 = this.state.move.position;
    const base = acked?.input ?? this.history[0]?.input;
    let s: SimState = {
      move: {
        ...own.move,
        yaw: base?.yaw ?? this.state.move.yaw,
        pitch: base?.pitch ?? this.state.move.pitch,
      },
      weapon: own.weapon,
    };
    for (const e of this.history) {
      s = stepSim(s, e.input, this.ctx, this.body).state;
      e.state = s;
    }
    this.state = s;

    const after = s.move.position;
    const dx = before[0] - after[0];
    const dy = before[1] - after[1];
    const dz = before[2] - after[2];
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

function sameState(a: SimState, b: OwnState): boolean {
  const m = a.move;
  const o = b.move;
  if (
    m.position[0] !== o.position[0] ||
    m.position[1] !== o.position[1] ||
    m.position[2] !== o.position[2] ||
    m.velocity[0] !== o.velocity[0] ||
    m.velocity[1] !== o.velocity[1] ||
    m.velocity[2] !== o.velocity[2] ||
    m.grounded !== o.grounded ||
    m.crouching !== o.crouching ||
    m.slideTicks !== o.slideTicks ||
    m.slideCooldownTicks !== o.slideCooldownTicks ||
    m.prevButtons !== o.prevButtons
  ) {
    return false;
  }
  const w = a.weapon;
  const v = b.weapon;
  return (
    w.slot === v.slot &&
    w.ammo[0].ammo === v.ammo[0].ammo &&
    w.ammo[0].reserve === v.ammo[0].reserve &&
    w.ammo[1].ammo === v.ammo[1].ammo &&
    w.ammo[1].reserve === v.ammo[1].reserve &&
    w.cooldownTicks === v.cooldownTicks &&
    w.reloadTicks === v.reloadTicks &&
    w.switchTicks === v.switchTicks &&
    w.adsTicks === v.adsTicks &&
    w.shotIndex === v.shotIndex &&
    w.recoilPitch === v.recoilPitch &&
    w.recoilYaw === v.recoilYaw &&
    w.bloom === v.bloom
  );
}
