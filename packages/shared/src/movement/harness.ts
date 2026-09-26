// Test helpers for movement. Not exported from the package.
import { maps, movement, type GameMap, type Movement } from '@sentinel/content';
import { expandMap, type Vec3 } from '../map/solids.ts';
import { buildWorld, initPhysics } from '../physics.ts';
import type { PlayerInput } from '../input.ts';
import {
  createMovementContext,
  createPlayerBody,
  type MovementContext,
  type PlayerBody,
} from './context.ts';
import { createPlayerState, type PlayerState } from './state.ts';
import { step } from './step.ts';

export interface Sim {
  ctx: MovementContext;
  body: PlayerBody;
  state: PlayerState;
  run(ticks: number, input: Partial<PlayerInput>): PlayerState;
}

export async function createSim(
  start: Vec3,
  opts: { map?: GameMap; yaw?: number; tuning?: Movement } = {},
): Promise<Sim> {
  const rapier = await initPhysics();
  const world = buildWorld(rapier, expandMap(opts.map ?? maps.greybox!));
  const ctx = createMovementContext(rapier, world, opts.tuning ?? movement);
  const body = createPlayerBody(ctx);
  const sim: Sim = {
    ctx,
    body,
    state: createPlayerState(start, opts.yaw ?? 0),
    run(ticks, input) {
      const full: PlayerInput = { buttons: 0, yaw: sim.state.yaw, pitch: 0, ...input };
      for (let i = 0; i < ticks; i++) sim.state = step(sim.state, full, ctx, body);
      return sim.state;
    },
  };
  // Settle onto the ground.
  sim.run(10, {});
  return sim;
}

export function horizontalSpeed(s: PlayerState): number {
  return Math.hypot(s.velocity[0], s.velocity[2]);
}

/** A flat 40×40 m floor plus extra boxes, for tests that need custom geometry. */
export function flatMap(extra: GameMap['geometry'] = []): GameMap {
  return {
    id: 'test-flat',
    name: 'Test flat',
    lighting: 'day',
    location: '',
    description: '',
    killY: -10,
    geometry: [
      { kind: 'box', center: [0, -0.5, 0], size: [40, 1, 40], yawDeg: 0, material: 'floor' },
      ...extra,
    ],
    spawns: [],
  };
}
