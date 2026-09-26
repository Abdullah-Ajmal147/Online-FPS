import { describe, expect, it } from 'vitest';
import { maps, type GameMap } from '@sentinel/content';
import { expandMap, quarterYawQuat, rotateYawQuarter, type Vec3 } from './solids.ts';

describe('rotateYawQuarter', () => {
  it('turns forward (-Z) to the left (-X) at +90 degrees', () => {
    expect(rotateYawQuarter([0, 0, -1], 90)).toEqual([-1, 0, 0]);
    expect(rotateYawQuarter([0, 0, -1], 180)).toEqual([0, 0, 1]);
    expect(rotateYawQuarter([0, 0, -1], 270)).toEqual([1, 0, 0]);
  });

  it('never returns -0', () => {
    for (const yaw of [0, 90, 180, 270] as const) {
      for (const c of rotateYawQuarter([0, 0, 0], yaw)) expect(Object.is(c, -0)).toBe(false);
    }
  });

  it('matches the quaternion for the same yaw', () => {
    // Rotate a vector with the quaternion and compare to the exact quarter turn.
    const rotateByQuat = (v: Vec3, [qx, qy, qz, qw]: readonly number[]): Vec3 => {
      const [x, y, z] = v;
      const tx = 2 * (qy! * z - qz! * y);
      const ty = 2 * (qz! * x - qx! * z);
      const tz = 2 * (qx! * y - qy! * x);
      return [
        x + qw! * tx + (qy! * tz - qz! * ty),
        y + qw! * ty + (qz! * tx - qx! * tz),
        z + qw! * tz + (qx! * ty - qy! * tx),
      ];
    };
    for (const yaw of [0, 90, 180, 270] as const) {
      const exact = rotateYawQuarter([1, 2, 3], yaw);
      const viaQuat = rotateByQuat([1, 2, 3], quarterYawQuat(yaw));
      exact.forEach((c, i) => expect(viaQuat[i]).toBeCloseTo(c, 12));
    }
  });
});

describe('expandMap', () => {
  const tinyMap = (geometry: GameMap['geometry']): GameMap => ({
    id: 'tiny',
    name: 'Tiny',
    lighting: 'day',
    location: '',
    description: '',
    points: [],
    killY: -10,
    geometry,
    spawns: [],
  });

  it('expands stairs into solid steps climbing forward', () => {
    const solids = expandMap(
      tinyMap([
        {
          kind: 'stairs',
          start: [0, 0, 0],
          width: 2,
          steps: 3,
          stepRise: 0.25,
          stepDepth: 0.5,
          yawDeg: 0,
          material: 'stairs',
        },
      ]),
    );
    expect(solids).toHaveLength(3);
    const last = solids[2]!;
    if (last.shape !== 'box') throw new Error('expected box');
    expect(last.center).toEqual([0, 0.375, -1.25]);
    expect(last.halfExtents).toEqual([1, 0.375, 0.25]);
  });

  it('builds a ramp wedge whose top edge is at the rise, one run forward after yaw', () => {
    const [ramp] = expandMap(
      tinyMap([
        { kind: 'ramp', base: [1, 0, 1], width: 2, run: 4, rise: 1, yawDeg: 270, material: 'ramp' },
      ]),
    );
    if (ramp?.shape !== 'hull') throw new Error('expected hull');
    // yaw 270 faces +X, so the high edge sits at x = 1 + 4.
    const top = ramp.points.filter((p) => p[1] === 1);
    expect(top.map((p) => p[0])).toEqual([5, 5]);
  });

  it('expands the greybox deterministically', () => {
    const a = expandMap(maps.greybox!);
    const b = expandMap(maps.greybox!);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(maps.greybox!.geometry.length);
  });
});
