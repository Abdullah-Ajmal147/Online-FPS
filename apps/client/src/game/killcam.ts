import {
  RemoteBuffer,
  TICK_RATE,
  TICKS_PER_SNAPSHOT,
  type EntityState,
  type RemotePose,
} from '@sentinel/shared';

/**
 * Killcam (owner feature list): after you die, replay the last moments from your killer's eyes.
 *
 * Client-only, built from snapshots this client already received: no protocol change, and it
 * can't reveal anything new. Because of server-side visibility (ADR 0009) we only have the
 * killer's movement from when they were visible or audible to us; with too little of it we
 * skip the replay and just turn the camera toward the killer (death cam).
 */

/** How much history is kept (a little more than the longest replay). */
const KEEP_TICKS = 4 * TICK_RATE;
/** Replay up to this long before the kill… */
export const REPLAY_BEFORE_TICKS = 2 * TICK_RATE;
/** …and this long after it (see the victim go down). */
export const REPLAY_AFTER_TICKS = Math.round(0.3 * TICK_RATE);
/** Less killer data than this: no replay (it would be a jump cut, not a killcam). */
export const MIN_KILLER_TICKS = Math.round(0.75 * TICK_RATE);
/** Pause on the death view before the replay starts. */
export const DEATH_PAUSE_MS = 500;

interface Frame {
  tick: number;
  entities: Map<number, EntityState>;
}

/** Rolling record of the last few seconds of snapshots (others + our own soldier). */
export class KillcamRecorder {
  /** Oldest first. Read by plans while recording goes on (the replay reaches past the kill). */
  frames: Frame[] = [];

  record(tick: number, entities: readonly EntityState[]): void {
    const last = this.frames.at(-1);
    if (last && tick <= last.tick) return;
    this.frames.push({ tick, entities: new Map(entities.map((e) => [e.id, e])) });
    while (this.frames.length > 0 && this.frames[0]!.tick < tick - KEEP_TICKS) this.frames.shift();
  }

  clear(): void {
    this.frames = [];
  }

  /**
   * Replay window for a kill at `killTick`: from when the killer has been continuously in our
   * snapshots (at most REPLAY_BEFORE_TICKS back) to shortly after the kill. Null if we saw too
   * little of the killer.
   */
  plan(killerId: number, killTick: number): KillcamPlan | null {
    let start = killTick;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.tick > killTick) continue;
      if (f.tick < killTick - REPLAY_BEFORE_TICKS || !f.entities.has(killerId)) break;
      // A gap in the recording (lost snapshots are fine; a long hole is not).
      const next = this.frames[i + 1];
      if (next && next.tick <= killTick && next.tick - f.tick > 6 * TICKS_PER_SNAPSHOT) break;
      start = f.tick;
    }
    if (killTick - start < MIN_KILLER_TICKS) return null;
    return new KillcamPlan(this, killerId, start, killTick + REPLAY_AFTER_TICKS);
  }
}

/** A planned replay: poses of everyone at any tick in [startTick, endTick]. */
export class KillcamPlan {
  private readonly buffers = new Map<number, RemoteBuffer>();
  /** Newest recorded tick fed to the buffers so far. */
  private fedTick = -Infinity;

  constructor(
    private readonly recorder: KillcamRecorder,
    readonly killerId: number,
    readonly startTick: number,
    readonly endTick: number,
  ) {}

  get durationMs(): number {
    return ((this.endTick - this.startTick) / TICK_RATE) * 1000;
  }

  /**
   * Everyone's pose at `tick` (moving forward only). Samples are fed to the interpolation
   * buffers as the replay reaches them, so each buffer only ever holds its recent window.
   */
  posesAt(tick: number): Map<number, RemotePose> {
    const lookahead = tick + 2 * TICKS_PER_SNAPSHOT;
    for (const f of this.recorder.frames) {
      if (f.tick < this.startTick - 2 * TICKS_PER_SNAPSHOT) continue;
      if (f.tick <= this.fedTick) continue;
      if (f.tick > lookahead) break;
      this.fedTick = f.tick;
      for (const [id, e] of f.entities) {
        let buf = this.buffers.get(id);
        if (!buf) this.buffers.set(id, (buf = new RemoteBuffer()));
        buf.push(f.tick, e);
      }
    }
    const poses = new Map<number, RemotePose>();
    for (const [id, buf] of this.buffers) {
      // Players who dropped out of our snapshots (left, or hidden again) are not drawn.
      if (buf.newestTick < this.fedTick - 6 * TICKS_PER_SNAPSHOT) continue;
      const p = buf.sample(tick);
      if (p) poses.set(id, p);
    }
    return poses;
  }
}
