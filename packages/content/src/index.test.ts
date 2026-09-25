import { describe, expect, it } from 'vitest';
import {
  MapSchema,
  ModeSchema,
  MovementSchema,
  WeaponSchema,
  defaultLoadout,
  maps,
  modes,
  movement,
  weapons,
} from './index.ts';

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

describe('map validation', () => {
  it('requires a spawn for each team', () => {
    const map = JSON.parse(JSON.stringify(maps.greybox)) as { spawns: { team: number }[] };
    map.spawns = map.spawns.filter((s) => s.team === 0);
    map.spawns.push({ ...map.spawns[0]! });
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

  it('caps slide timers so they fit the u8 wire field', () => {
    expect(MovementSchema.safeParse({ ...movement, slideDuration: 5 }).success).toBe(false);
    expect(MovementSchema.safeParse({ ...movement, slideCooldown: 5 }).success).toBe(false);
  });

  it('rejects speeds in the wrong order', () => {
    expect(MovementSchema.safeParse({ ...movement, crouchSpeed: 9 }).success).toBe(false);
  });
});

describe('weapons', () => {
  it('has an original rifle and sidearm in the default loadout', () => {
    expect(defaultLoadout.map((w) => [w.class, w.slot])).toEqual([
      ['rifle', 0],
      ['sidearm', 1],
    ]);
  });

  it('kills in 4–5 rifle body shots, about 0.3–0.5 s (GAME_DESIGN medium-fast TTK)', () => {
    const rifle = weapons['kestrel-ar']!;
    const shots = Math.ceil(100 / rifle.damage.torso);
    expect(shots).toBeGreaterThanOrEqual(4);
    expect(shots).toBeLessThanOrEqual(5);
    const ttk = ((shots - 1) * 60) / rifle.rpm;
    expect(ttk).toBeGreaterThanOrEqual(0.3);
    expect(ttk).toBeLessThanOrEqual(0.5);
  });

  it('rejects bad weapon data', () => {
    const rifle = weapons['kestrel-ar']!;
    expect(WeaponSchema.safeParse({ ...rifle, rpm: 5000 }).success).toBe(false);
    expect(
      WeaponSchema.safeParse({ ...rifle, damage: { head: 10, torso: 20, limbs: 5 } }).success,
    ).toBe(false);
    expect(
      WeaponSchema.safeParse({ ...rifle, falloff: { start: 30, end: 20, minMultiplier: 1 } })
        .success,
    ).toBe(false);
    expect(WeaponSchema.safeParse({ ...rifle, magazine: 300 }).success).toBe(false);
  });
});
