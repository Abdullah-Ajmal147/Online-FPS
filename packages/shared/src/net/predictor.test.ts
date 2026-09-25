import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLoadout, maps, movement } from '@sentinel/content';
import { Button } from '../input.ts';
import { expandMap } from '../map/solids.ts';
import { createMovementContext, createPlayerBody } from '../movement/context.ts';
import { createPlayerState } from '../movement/state.ts';
import { buildWorld, initPhysics, type Rapier } from '../physics.ts';
import { createSimContext, stepSim, type SimState } from '../combat/sim.ts';
import { createWeaponState } from '../combat/weapon.ts';
import { Predictor } from './predictor.ts';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

function setup() {
  const moveCtx = createMovementContext(
    rapier,
    buildWorld(rapier, expandMap(maps.greybox!)),
    movement,
  );
  const ctx = createSimContext(moveCtx, defaultLoadout);
  const spawn: SimState = {
    move: createPlayerState([-20, 0, 20], 0),
    weapon: createWeaponState(ctx.loadout),
  };
  return { ctx, body: createPlayerBody(moveCtx), spawn };
}

const input = (i: number) => ({
  buttons: Button.Forward,
  yaw: i * 10,
  pitch: 0,
  weaponSlot: 0,
  viewTick: i,
});

describe('Predictor.reset', () => {
  it('on join drops all history (offline inputs are never replayed)', () => {
    const { ctx, body, spawn } = setup();
    const p = new Predictor(spawn, ctx, body);
    for (let i = 0; i < 30; i++) p.tick(input(i));
    p.reset(spawn);
    expect(p.state).toEqual(spawn);
    expect(p.recentInputs()).toEqual([]);
  });

  it('on respawn replays inputs the server has not applied yet', () => {
    const { ctx, body, spawn } = setup();
    const p = new Predictor(spawn, ctx, body);
    for (let i = 0; i < 30; i++) p.tick(input(i)); // seqs 1..30
    // Server respawned us at `spawn` and has applied up to seq 25; 26..30 are in flight.
    p.reset(spawn, 25);
    let expected = spawn;
    const server = setup();
    for (let i = 25; i < 30; i++)
      expected = stepSim(expected, input(i), server.ctx, server.body).state;
    expect(p.state).toEqual(expected);
  });
});

describe('Predictor skip ticks', () => {
  it('sends but does not simulate skipped ticks, in live ticks and in replays', () => {
    const { ctx, body, spawn } = setup();
    const p = new Predictor(spawn, ctx, body);
    const before = p.state;
    const r = p.tick(input(1), { skip: true });
    expect(r.sent.seq).toBe(1);
    expect(p.state).toBe(before);
    p.tick(input(2));
    // Reconcile from the spawn with nothing acked: replay must skip seq 1 again.
    p.reset(spawn, 0);
    const server = setup();
    const expected = stepSim(spawn, input(2), server.ctx, server.body).state;
    expect(p.state).toEqual(expected);
  });
});
