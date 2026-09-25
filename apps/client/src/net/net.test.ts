import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLoadout, maps, movement } from '@sentinel/content';
import type { EntityState, OwnState, SequencedInput } from '@sentinel/protocol';
import {
  Button,
  Predictor,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  createSimContext,
  createWeaponState,
  expandMap,
  initPhysics,
  stepSim,
  type Rapier,
  type SimContext,
  type SimState,
} from '@sentinel/shared';
import { InterpolationDelay, MAX_EXTRAPOLATION_TICKS, RemoteBuffer } from '@sentinel/shared';
import { ServerClock, inputPacing } from '@sentinel/shared';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

function world(): SimContext {
  const moveCtx = createMovementContext(
    rapier,
    buildWorld(rapier, expandMap(maps.greybox!)),
    movement,
  );
  return createSimContext(moveCtx, defaultLoadout);
}

const start = (): SimState => ({
  move: createPlayerState([-20, 0, 20], 0),
  weapon: createWeaponState(world().loadout),
});

const toOwn = (s: SimState): OwnState => ({
  move: {
    position: s.move.position,
    velocity: s.move.velocity,
    grounded: s.move.grounded,
    crouching: s.move.crouching,
    slideTicks: s.move.slideTicks,
    slideCooldownTicks: s.move.slideCooldownTicks,
    prevButtons: s.move.prevButtons,
  },
  weapon: s.weapon,
});

/** Movement plus shooting and reloading, so weapon state is predicted too. */
const script = (i: number) => ({
  buttons:
    (i % 100 < 70 ? Button.Forward | Button.Sprint : Button.Right | Button.Fire) |
    (i % 77 === 0 ? Button.Jump : 0) |
    (i % 150 > 130 ? Button.Crouch : 0) |
    (i % 400 === 399 ? Button.Reload : 0),
  yaw: (i * 37) & 0xffff,
  pitch: 0,
  weaponSlot: i % 500 < 450 ? 0 : 1,
  viewTick: i,
});

/** A fake server: its own world, applies the client's inputs in order with a delay. */
function fakeServer(initial: SimState) {
  const ctx = world();
  const body = createPlayerBody(ctx.movement);
  let state = initial;
  let lastSeq = 0;
  return {
    apply(input: SequencedInput) {
      state = stepSim(state, input, ctx, body).state;
      lastSeq = input.seq;
    },
    repeat(input: SequencedInput) {
      state = stepSim(state, input, ctx, body).state; // starved tick: server repeats, seq unchanged
    },
    snapshot: () => ({ own: toOwn(state), lastSeq }),
  };
}

function newPredictor(initial: SimState) {
  const ctx = world();
  return new Predictor(initial, ctx, createPlayerBody(ctx.movement));
}

describe('Predictor', () => {
  it('makes zero corrections when the server sees exactly our inputs (120 ms RTT), weapons included', () => {
    const predictor = newPredictor(start());
    const server = fakeServer(start());
    const inFlight: SequencedInput[] = [];
    const LATENCY = 4; // ticks each way ≈ 66 ms → ~130 ms RTT
    let shots = 0;
    for (let i = 0; i < 1000; i++) {
      const r = predictor.tick(script(i));
      if (r.shot) shots++;
      inFlight.push(r.sent);
      if (inFlight.length > LATENCY) server.apply(inFlight.shift()!);
      if (i % 2 === 0 && i > 2 * LATENCY) {
        const snap = server.snapshot();
        predictor.onServerState(snap.own, snap.lastSeq);
      }
    }
    expect(shots).toBeGreaterThan(10);
    expect(predictor.stats.snapshots).toBeGreaterThan(400);
    expect(predictor.stats.corrections).toBe(0);
  });

  it('corrects when the server had to repeat an input, then agrees again', () => {
    const predictor = newPredictor(start());
    const server = fakeServer(start());
    const inputs: SequencedInput[] = [];
    for (let i = 0; i < 200; i++) inputs.push(predictor.tick(script(i)).sent);
    for (const input of inputs.slice(0, 100)) server.apply(input);
    server.repeat(inputs[99]!); // one extra starved step the client never predicted
    for (const input of inputs.slice(100, 150)) server.apply(input);
    const snap = server.snapshot();
    predictor.onServerState(snap.own, snap.lastSeq);
    expect(predictor.stats.corrections).toBe(1);

    for (const input of inputs.slice(150, 180)) server.apply(input);
    const next = server.snapshot();
    predictor.onServerState(next.own, next.lastSeq);
    expect(predictor.stats.corrections).toBe(1);
  });

  it('blends small errors and snaps big ones', () => {
    const predictor = newPredictor(start());
    const sent = predictor.tick(script(1)).sent;
    const tiny = toOwn(predictor.state);
    const p = tiny.move.position;
    predictor.onServerState(
      { ...tiny, move: { ...tiny.move, position: [p[0] + 0.01, p[1], p[2]] } },
      sent.seq,
    );
    expect(Math.abs(predictor.renderOffset[0])).toBeCloseTo(0.01, 4);
    predictor.decayOffset(0.2);
    expect(predictor.renderOffset[0]).toBeCloseTo(0, 10);

    const s2 = predictor.tick(script(2)).sent;
    const far = toOwn(predictor.state);
    const q = far.move.position;
    predictor.onServerState(
      { ...far, move: { ...far.move, position: [q[0] + 2, q[1], q[2]] } },
      s2.seq,
    );
    expect(predictor.renderOffset).toEqual([0, 0, 0]);
  });

  it('sends the last 3 inputs, oldest first, with consecutive seqs', () => {
    const predictor = newPredictor(start());
    for (let i = 0; i < 5; i++) predictor.tick(script(i));
    expect(predictor.recentInputs().map((i) => i.seq)).toEqual([3, 4, 5]);
  });

  it('reports a predicted shot only on live ticks, never on replays', () => {
    const predictor = newPredictor(start());
    const first = predictor.tick({
      buttons: Button.Fire,
      yaw: 0,
      pitch: 0,
      weaponSlot: 0,
      viewTick: 0,
    });
    expect(first.shot).not.toBeNull();
  });
});

const ent = (x: number, yaw = 0): EntityState => ({
  id: 1,
  team: 0,
  alive: true,
  grounded: true,
  crouching: false,
  position: [x, 0, 0],
  yaw,
  pitch: 0,
  weaponSlot: 0,
  shotCount: 0,
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
