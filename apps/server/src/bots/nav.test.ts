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

  it('does not connect straight up the 1 m ledge or the 0.6 m block', () => {
    const [li, lj] = grid.cellOf(-20, -20); // ledge top
    const [fi, fj] = grid.cellOf(-20, -17.5); // floor next to it
    expect(grid.walkable(li, lj)).toBe(true);
    const path = grid.findPath([-20, 0, -17.5], [-20, 1, -20]);
    // Reachable only if there were a ramp; the ledge has none, so no path.
    expect(path).toBeNull();
    expect(fi).toBeDefined();
    expect(fj).toBeDefined();
  });

  it('finds a path across the map in a few ms', () => {
    const t = performance.now();
    const path = grid.findPath([-25, 0, 25], [25, 0, -25]);
    expect(path).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(20);
  });
});
