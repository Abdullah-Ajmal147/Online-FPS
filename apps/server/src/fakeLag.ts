import { createRng } from '@sentinel/shared';

/**
 * Fake network conditions for testing (docs/NETCODE.md "Testing", CLAUDE.md rule 6).
 * `rttMs` is the added round trip: each direction gets half of it, plus up to ±half the jitter.
 */
export interface LagPreset {
  rttMs: number;
  jitterMs: number;
  /** Chance that a droppable message is lost, per message, per direction. */
  loss: number;
}

export const LAG_PRESETS = {
  good: { rttMs: 40, jitterMs: 0, loss: 0 },
  normal: { rttMs: 120, jitterMs: 20, loss: 0.03 },
  bad: { rttMs: 250, jitterMs: 60, loss: 0.08 },
} as const satisfies Record<string, LagPreset>;

export type LagPresetName = keyof typeof LAG_PRESETS;

/**
 * SENTINEL_LAG: a preset name (good | normal | bad) or a custom "rttMs:jitterMs:loss",
 * e.g. "150:20:0.03" for the Phase 2 hit-registration test at 150 ms.
 */
export function presetFromEnv(value: string | undefined): LagPreset | null {
  if (!value) return null;
  if (value in LAG_PRESETS) return LAG_PRESETS[value as LagPresetName];
  const m = /^(\d+):(\d+):(0(?:\.\d+)?|1)$/.exec(value);
  if (m) return { rttMs: Number(m[1]), jitterMs: Number(m[2]), loss: Number(m[3]) };
  throw new Error(
    `SENTINEL_LAG must be ${Object.keys(LAG_PRESETS).join(', ')} or "rtt:jitter:loss", got "${value}"`,
  );
}
type Schedule = (fn: () => void, delayMs: number) => void;

/**
 * Delays (and sometimes drops) messages. Messages on the same lane (one client, one direction)
 * are never reordered, like a real WebSocket over TCP; jitter only changes the spacing.
 * Only the fast path may be dropped (inputs, snapshots, pings) — the netcode must survive that,
 * and it's what a future unreliable transport (WebTransport, Phase 8) will do for real.
 */
export class FakeLag {
  private laneReadyAt = new Map<string, number>();
  private readonly random: () => number;

  constructor(
    readonly preset: LagPreset,
    seed = 1,
    private readonly now: () => number = () => performance.now(),
    private readonly schedule: Schedule = (fn, ms) => void setTimeout(fn, ms),
  ) {
    this.random = createRng(seed);
  }

  /** Run `deliver` after the simulated one-way delay, or never if the message is "lost". */
  pass(lane: string, deliver: () => void, droppable: boolean): void {
    if (droppable && this.random() < this.preset.loss) return;
    const oneWay = this.preset.rttMs / 2 + (this.random() * 2 - 1) * (this.preset.jitterMs / 2);
    const t = this.now();
    const at = Math.max(this.laneReadyAt.get(lane) ?? 0, t + Math.max(0, oneWay));
    this.laneReadyAt.set(lane, at);
    this.schedule(deliver, at - t);
  }

  forget(clientId: string): void {
    this.laneReadyAt.delete(`${clientId}:in`);
    this.laneReadyAt.delete(`${clientId}:out`);
  }
}
