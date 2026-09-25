import { beforeAll, describe, expect, it } from 'vitest';
import { maps, movement } from '@sentinel/content';
import type { EntityState, OwnState, SequencedInput } from '@sentinel/protocol';
import {
  Button,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  expandMap,
  initPhysics,
  step,
  type MovementContext,
  type PlayerState,
  type Rapier,
} from '@sentinel/shared';
import { Predictor } from '@sentinel/shared';
import { InterpolationDelay, MAX_EXTRAPOLATION_TICKS, RemoteBuffer } from './interpolator.ts';
import { ServerClock, inputPacing } from './clock.ts';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

function world(): MovementContext {
  return createMovementContext(rapier, buildWorld(rapier, expandMap(maps.greybox!)), movement);
}

const toOwn = (s: PlayerState): OwnState => ({
  position: s.position,
  velocity: s.velocity,
  grounded: s.grounded,
  crouching: s.crouching,
  slideTicks: s.slideTicks,
  slideCooldownTicks: s.slideCooldownTicks,
  prevButtons: s.prevButtons,
});

const script = (i: number) => ({
  buttons:
    (i % 100 < 70 ? Button.Forward | Button.Sprint : Button.Right) |
    (i % 77 === 0 ? Button.Jump : 0) |
    (i % 150 > 130 ? Button.Crouch : 0),
  yaw: (i * 37) & 0xffff,
  pitch: 0,
  weaponSlot: 0,
});

/** A fake server: its own world, applies the client's inputs in order with a delay. */
function fakeServer(initial: PlayerState) {
  const ctx = world();
  const body = createPlayerBody(ctx);
  let state = initial;
  let lastSeq = 0;
  return {
    apply(input: SequencedInput) {
      state = step(state, input, ctx, body);
      lastSeq = input.seq;
    },
    repeat(input: SequencedInput) {
      state = step(state, input, ctx, body); // starved tick: server repeats, seq unchanged
    },
    snapshot: () => ({ own: toOwn(state), lastSeq }),
  };
}

describe('Predictor', () => {
  it('makes zero corrections when the server sees exactly our inputs (120 ms RTT)', () => {
    const start = createPlayerState([-20, 0, 20], 0);
    const ctx = world();
    const predictor = new Predictor(start, ctx, createPlayerBody(ctx));
    const server = fakeServer(start);
    const inFlight: SequencedInput[] = [];
    const LATENCY = 4; // ticks each way ≈ 66 ms → ~130 ms RTT
    for (let i = 0; i < 1000; i++) {
      inFlight.push(predictor.tick(script(i)));
      if (inFlight.length > LATENCY) server.apply(inFlight.shift()!);
      if (i % 2 === 0 && i > 2 * LATENCY) {
        const snap = server.snapshot();
        predictor.onServerState(snap.own, snap.lastSeq);
      }
    }
    expect(predictor.stats.snapshots).toBeGreaterThan(400);
    expect(predictor.stats.corrections).toBe(0);
  });

  it('corrects when the server had to repeat an input, then agrees again', () => {
    const start = createPlayerState([-20, 0, 20], 0);
    const ctx = world();
    const predictor = new Predictor(start, ctx, createPlayerBody(ctx));
    const server = fakeServer(start);
    const inputs: SequencedInput[] = [];
    for (let i = 0; i < 200; i++) inputs.push(predictor.tick(script(i)));
    for (const input of inputs.slice(0, 100)) server.apply(input);
    server.repeat(inputs[99]!); // one extra starved step the client never predicted
    for (const input of inputs.slice(100, 150)) server.apply(input);
    const snap = server.snapshot();
    predictor.onServerState(snap.own, snap.lastSeq);
    expect(predictor.stats.corrections).toBe(1);

    // Replay made the prediction consistent with the server: the next snapshot needs no fix.
    for (const input of inputs.slice(150, 180)) server.apply(input);
    const next = server.snapshot();
    predictor.onServerState(next.own, next.lastSeq);
    expect(predictor.stats.corrections).toBe(1);
  });

  it('blends small errors and snaps big ones', () => {
    const start = createPlayerState([-20, 0, 20], 0);
    const ctx = world();
    const predictor = new Predictor(start, ctx, createPlayerBody(ctx));
    const sent = predictor.tick(script(1));
    const tiny = toOwn(predictor.state);
    predictor.onServerState(
      { ...tiny, position: [tiny.position[0] + 0.01, tiny.position[1], tiny.position[2]] },
      sent.seq,
    );
    expect(Math.abs(predictor.renderOffset[0])).toBeCloseTo(0.01, 4);
    predictor.decayOffset(0.2);
    expect(predictor.renderOffset[0]).toBeCloseTo(0, 10);

    const s2 = predictor.tick(script(2));
    const far = toOwn(predictor.state);
    predictor.onServerState(
      { ...far, position: [far.position[0] + 2, far.position[1], far.position[2]] },
      s2.seq,
    );
    expect(predictor.renderOffset).toEqual([0, 0, 0]);
  });

  it('sends the last 3 inputs, oldest first, with consecutive seqs', () => {
    const ctx = world();
    const predictor = new Predictor(createPlayerState([0, 0, 0], 0), ctx, createPlayerBody(ctx));
    for (let i = 0; i < 5; i++) predictor.tick(script(i));
    expect(predictor.recentInputs().map((i) => i.seq)).toEqual([3, 4, 5]);
  });
});

const ent = (x: number, yaw = 0): EntityState => ({
  id: 1,
  team: 0,
  grounded: true,
  crouching: false,
  position: [x, 0, 0],
  yaw,
  pitch: 0,
});

describe('RemoteBuffer', () => {
  it('interpolates between the two snapshots around the render time', () => {
    const b = new RemoteBuffer();
    b.push(10, ent(0));
    b.push(12, ent(2));
    expect(b.sample(11)!.position[0]).toBeCloseTo(1, 10);
  });

  it('ignores late and duplicate snapshots', () => {
    const b = new RemoteBuffer();
    b.push(10, ent(0));
    b.push(12, ent(2));
    b.push(11, ent(100));
    b.push(12, ent(100));
    expect(b.sample(11)!.position[0]).toBeCloseTo(1, 10);
  });

  it('extrapolates at most 50 ms past the newest snapshot, then holds', () => {
    const b = new RemoteBuffer();
    b.push(10, ent(0));
    b.push(12, ent(2)); // 1 m per tick
    expect(b.sample(13)!.position[0]).toBeCloseTo(3, 10);
    expect(b.sample(100)!.position[0]).toBeCloseTo(2 + MAX_EXTRAPOLATION_TICKS, 10);
  });

  it('turns the short way round across yaw 0', () => {
    const b = new RemoteBuffer();
    b.push(10, ent(0, 65000));
    b.push(12, ent(0, 500));
    const yaw = b.sample(11)!.yaw;
    const mid = ((65000 + (65536 + 500 - 65000) / 2) / 65536) * 2 * Math.PI;
    expect(yaw).toBeCloseTo(mid, 6);
  });
});

describe('RemoteBuffer teleports', () => {
  it('snaps instead of sliding across the map on a respawn', () => {
    const b = new RemoteBuffer();
    b.push(10, ent(0));
    b.push(12, ent(0.2));
    b.push(14, ent(40)); // respawned far away
    expect(b.sample(13)!.position[0]).toBe(40);
  });

  it('forgets the old player when an id is reused by the other team', () => {
    const b = new RemoteBuffer();
    b.push(10, ent(0));
    b.push(12, { ...ent(0.5), team: 1 });
    expect(b.sample(11)!.team).toBe(1);
  });
});

describe('InterpolationDelay', () => {
  it('stays at 2 snapshots with steady arrivals and grows (≤100 ms) with jitter', () => {
    const steady = new InterpolationDelay();
    for (let i = 0; i < 100; i++) steady.onSnapshotArrival(i * (1000 / 30));
    expect(steady.ticks).toBeCloseTo(4, 5);

    const jittery = new InterpolationDelay();
    let t = 0;
    for (let i = 0; i < 200; i++) jittery.onSnapshotArrival((t += 1000 / 30 + (i % 2 ? 20 : -20)));
    expect(jittery.ticks).toBeGreaterThan(4);
    expect(jittery.ticks).toBeLessThanOrEqual(6);
  });
});

describe('ServerClock and pacing', () => {
  it('advances smoothly between snapshots', () => {
    const c = new ServerClock();
    expect(c.now(0)).toBeNull();
    c.onSnapshot(600, 10_000);
    expect(c.now(10_500)).toBeCloseTo(630, 5);
  });

  it('speeds up when the server queue runs low and slows when it grows, within ±5%', () => {
    expect(inputPacing(2)).toBe(1);
    expect(inputPacing(0)).toBeGreaterThan(1);
    expect(inputPacing(8)).toBeLessThan(1);
    expect(inputPacing(100)).toBe(0.95);
    expect(inputPacing(-100)).toBe(1.05);
  });
});
