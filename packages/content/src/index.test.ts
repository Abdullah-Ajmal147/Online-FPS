import { describe, expect, it } from 'vitest';
import { MapSchema, ModeSchema, MovementSchema, maps, modes, movement } from './index.ts';

describe('content', () => {
  it('loads Team Deathmatch as 6v6', () => {
    const tdm = modes['team-deathmatch'];
    expect(tdm?.teams).toBe(2);
    expect(tdm?.playersPerTeam).toBe(6);
  });

  it('rejects invalid mode data', () => {
    expect(() => ModeSchema.parse({ id: 'Bad Id', name: '' })).toThrow();
  });
});

describe('maps', () => {
  it('loads the greybox with spawns for both teams', () => {
    const greybox = maps.greybox!;
    expect(new Set(greybox.spawns.map((s) => s.team))).toEqual(new Set([0, 1]));
    for (const kind of ['box', 'ramp', 'stairs']) {
      expect(greybox.geometry.some((g) => g.kind === kind)).toBe(true);
    }
  });

  it('only allows quarter-turn yaw on geometry', () => {
    const map = JSON.parse(JSON.stringify(maps.greybox)) as unknown as {
      geometry: { yawDeg?: number }[];
    };
    map.geometry[0]!.yawDeg = 45;
    expect(MapSchema.safeParse(map).success).toBe(false);
  });

  it('rejects non-positive box sizes', () => {
    const map = JSON.parse(JSON.stringify(maps.greybox)) as unknown as {
      geometry: { size?: number[] }[];
    };
    map.geometry[0]!.size = [1, 0, 1];
    expect(MapSchema.safeParse(map).success).toBe(false);
  });
});

describe('movement tuning', () => {
  it('uses the approved starting numbers', () => {
    expect(movement.walkSpeed).toBe(5);
    expect(movement.sprintSpeed).toBe(7.5);
    expect(movement.crouchSpeed).toBe(2.5);
    expect(movement.jumpHeight).toBe(1.1);
    expect(movement.slideDuration).toBe(0.8);
  });

  it('rejects speeds in the wrong order', () => {
    expect(MovementSchema.safeParse({ ...movement, crouchSpeed: 9 }).success).toBe(false);
  });
});
