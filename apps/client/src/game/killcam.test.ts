import { describe, expect, it } from 'vitest';
import { TICK_RATE, TICKS_PER_SNAPSHOT, type EntityState } from '@sentinel/shared';
import {
  KillcamRecorder,
  MIN_KILLER_TICKS,
  REPLAY_AFTER_TICKS,
  REPLAY_BEFORE_TICKS,
} from './killcam.ts';

const ME = 1;
const KILLER = 7;
const ent = (id: number, x: number, alive = true): EntityState => ({
  id,
  team: id === ME ? 0 : 1,
  alive,
  crouching: false,
  grounded: true,
  position: [x, 0, 0],
  yaw: 0,
  pitch: 0,
  weapon: 0,
  shotCount: 0,
});

/** Snapshots every TICKS_PER_SNAPSHOT ticks; the killer present from `killerFrom` on. */
function record(killerFrom: number, until: number): KillcamRecorder {
  const r = new KillcamRecorder();
  for (let t = 0; t <= until; t += TICKS_PER_SNAPSHOT) {
    const list = [ent(ME, 0, t < until)];
    if (t >= killerFrom) list.push(ent(KILLER, t / TICK_RATE));
    r.record(t, list);
  }
  return r;
}

describe('killcam', () => {
  it('replays up to 2 s before the kill, plus a moment after', () => {
    const kill = 5 * TICK_RATE;
    const plan = record(0, kill).plan(KILLER, kill)!;
    expect(plan.startTick).toBe(kill - REPLAY_BEFORE_TICKS);
    expect(plan.endTick).toBe(kill + REPLAY_AFTER_TICKS);
    // Fits inside the 3 s respawn with the death pause (2.3 s + 0.5 s).
    expect(plan.durationMs).toBeLessThanOrEqual(2400);
  });

  it('starts only where the killer is in our snapshots (server-side visibility)', () => {
    const kill = 5 * TICK_RATE;
    const plan = record(kill - TICK_RATE, kill).plan(KILLER, kill)!;
    expect(plan.startTick).toBe(kill - TICK_RATE);
    // Seen too briefly: no replay.
    expect(
      record(kill - MIN_KILLER_TICKS + TICKS_PER_SNAPSHOT, kill).plan(KILLER, kill),
    ).toBeNull();
    // Never seen (killed from hiding): no replay.
    expect(record(kill + 1, kill).plan(KILLER, kill)).toBeNull();
  });

  it('interpolates everyone during the replay, the victim included', () => {
    const kill = 5 * TICK_RATE;
    const plan = record(0, kill).plan(KILLER, kill)!;
    const mid = plan.startTick + 30 + 1; // between two snapshots
    const poses = plan.posesAt(mid);
    expect(poses.get(ME)?.alive).toBe(true);
    expect(poses.get(KILLER)!.position[0]).toBeCloseTo(mid / TICK_RATE, 3);
    // Later: the victim is down.
    expect(plan.posesAt(kill + REPLAY_AFTER_TICKS).get(ME)?.alive).toBe(false);
  });
});
