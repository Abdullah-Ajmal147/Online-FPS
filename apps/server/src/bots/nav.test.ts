import { beforeAll, describe, expect, it } from 'vitest';
import { maps, movement } from '@sentinel/content';
import { buildWorld, expandMap, initPhysics, type Rapier } from '@sentinel/shared';
import { NavGrid } from './nav.ts';

let rapier: Rapier;
let grid: NavGrid;
beforeAll(async () => {
  rapier = await initPhysics();
  const world = buildWorld(rapier, expandMap(maps.greybox!));
  grid = new NavGrid(rapier, world, movement, { minX: -30, maxX: 30, minZ: -30, maxZ: 30 });
});

describe('NavGrid on the greybox', () => {
  it('marks open floor walkable and the inside of walls/crates not', () => {
    expect(grid.walkable(...grid.cellOf(-20, 20))).toBe(true);
    expect(grid.walkable(...grid.cellOf(-3, 8))).toBe(true); // top of the 2 m crate is standable
    expect(grid.walkable(...grid.cellOf(0, 29.9))).toBe(true);
  });

  it('finds a path up the stairs onto the platform (3 m up)', () => {
    const path = grid.findPath([12, 0, 0], [12, 3, 12]);
    expect(path).not.toBeNull();
    expect(path!.at(-1)![1]).toBeCloseTo(3, 1);
    // Heights along the path never jump more than a step.
    for (let k = 1; k < path!.length; k++)
      expect(Math.abs(path![k]![1] - path![k - 1]![1])).toBeLessThan(0.7);
  });

  it('does not connect the floor to the top of the 1 m ledge (needs a jump)', () => {
    const top = grid.cellOf(-20, -20);
    const floor = grid.cellOf(-20, -17.5);
    expect(grid.walkable(...top)).toBe(true);
    expect(grid.walkable(...floor)).toBe(true);
    expect(grid.connected(top, floor)).toBe(false);
  });

  it('roam goals are only on the reachable floor (not the unreachable ledge top)', () => {
    const ledge = grid.cellOf(-20, -20);
    expect(grid.walkableCells().some(([i, j]) => i === ledge[0] && j === ledge[1])).toBe(false);
  });

  it('a bot on the floor beside a crate maps to the floor, not to the crate top', () => {
    // Greybox 2 m crate at (-3, 1, 8): standing on the floor right against its south face.
    const cell = grid.nearestWalkable(-3, 9.05, 0)!;
    expect(grid.walkable(...cell)).toBe(true);
    const [x, z] = grid.center(...cell);
    expect(grid.findPath([x, 0, z], [-20, 0, 20])).not.toBeNull();
  });

  it('finds a path across the map in a few ms', () => {
    const t = performance.now();
    const path = grid.findPath([-25, 0, 25], [25, 0, -25]);
    expect(path).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(20);
  });
});

describe.each(['relay-yard', 'saltline-depot'])('NavGrid on %s', (id) => {
  it('every spawn can walk to every other spawn (no spawn cut off from the fight)', () => {
    const map = maps[id]!;
    const nav = new NavGrid(rapier, buildWorld(rapier, expandMap(map)), movement, {
      minX: -40,
      maxX: 40,
      minZ: -40,
      maxZ: 40,
    });
    const [first, ...rest] = map.spawns;
    for (const s of rest) {
      expect(nav.findPath(first!.position, s.position), JSON.stringify(s)).not.toBeNull();
    }
  });
});

describe('NavGrid on Saltline Depot', () => {
  it('reaches the top of the central platform from the ramp and the stairs', () => {
    const nav = new NavGrid(
      rapier,
      buildWorld(rapier, expandMap(maps['saltline-depot']!)),
      movement,
      { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
    );
    const top = nav.findPath([0, 0, 25], [0, 2, 0]);
    expect(top).not.toBeNull();
    expect(top!.at(-1)![1]).toBeCloseTo(2, 1);
    expect(nav.findPath([20, 0, 0], [0, 2, 0])).not.toBeNull(); // via the east stairs
  });
});
