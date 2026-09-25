import { beforeAll, describe, expect, it } from 'vitest';
import { maps } from '@sentinel/content';
import { expandMap } from './map/solids.ts';
import {
  buildWorld,
  groundHeightBelow,
  initPhysics,
  type PhysicsWorld,
  type Rapier,
} from './physics.ts';

let rapier: Rapier;
let world: PhysicsWorld;
const ground = (x: number, z: number) => groundHeightBelow(rapier, world, [x, 50, z]);

beforeAll(async () => {
  rapier = await initPhysics();
  world = buildWorld(rapier, expandMap(maps.greybox!));
});

describe('greybox physics world', () => {
  it('has the floor at y = 0 in open space', () => {
    expect(ground(-20, 20)).toBeCloseTo(0, 5);
  });

  it('has the platform top at y = 3', () => {
    expect(ground(12, 12)).toBeCloseTo(3, 5);
  });

  it('has stairs rising 0.25 m per 0.4 m step towards the platform', () => {
    expect(ground(12, 3.4)).toBeCloseTo(0.25, 5); // first step
    expect(ground(12, 5.4)).toBeCloseTo(1.5, 5); // sixth step
    expect(ground(12, 7.8)).toBeCloseTo(3, 5); // last step, level with the platform
  });

  it('has the 20° ramp at half height halfway along', () => {
    // Ramp base x = -0.2, run 8.2, rise 3, climbing +X; halfway is x = 3.9.
    expect(ground(3.9, 12)).toBeCloseTo(1.5, 4);
  });

  it('has step-test blocks of 0.3 m and 0.6 m', () => {
    expect(ground(-8, 5)).toBeCloseTo(0.3, 5);
    expect(ground(-12, 5)).toBeCloseTo(0.6, 5);
  });

  it('keeps every spawn above solid ground', () => {
    for (const spawn of maps.greybox!.spawns) {
      const [x, y, z] = spawn.position;
      expect(groundHeightBelow(rapier, world, [x, y + 1, z])).toBeCloseTo(y, 5);
    }
  });

  it('has nothing to stand on outside the walls', () => {
    expect(ground(100, 100)).toBeNull();
  });
});
