import { describe, expect, it } from 'vitest';
import { movement } from '@sentinel/content';
import { damageAt, directionFromAngles, rayPlayer } from './hitbox.ts';

const feet = [0, 0, -10] as const;

describe('directionFromAngles', () => {
  it('yaw 0 pitch 0 looks down -Z; +16384 pitch looks straight up', () => {
    const d = directionFromAngles(0, 0);
    expect(d[2]).toBeCloseTo(-1, 12);
    expect(directionFromAngles(0, 16384)[1]).toBeCloseTo(1, 12);
    expect(directionFromAngles(16384, 0)[0]).toBeCloseTo(-1, 12); // quarter turn left → -X
  });
});

describe('rayPlayer', () => {
  const shoot = (y: number, x = 0, crouching = false) =>
    rayPlayer([x, y, 0], [0, 0, -1], feet, crouching, movement, 100);

  it('hits head, torso and limbs at the right heights', () => {
    expect(shoot(1.64)?.zone).toBe('head');
    expect(shoot(1.2)?.zone).toBe('torso');
    expect(shoot(0.5)?.zone).toBe('limbs');
  });

  it('reports the distance to the front surface', () => {
    expect(shoot(1.2)!.distance).toBeCloseTo(10 - 0.24, 3);
  });

  it('misses above the head and beside the body', () => {
    expect(shoot(2.0)).toBeNull();
    expect(shoot(1.2, 0.6)).toBeNull();
  });

  it('crouching lowers the head', () => {
    expect(shoot(1.64, 0, true)).toBeNull();
    expect(shoot(1.1, 0, true)?.zone).toBe('head');
  });

  it('respects max distance and ignores targets behind the shooter', () => {
    expect(rayPlayer([0, 1.2, 0], [0, 0, -1], feet, false, movement, 5)).toBeNull();
    expect(rayPlayer([0, 1.2, -20], [0, 0, -1], feet, false, movement, 100)).toBeNull();
  });
});

describe('damageAt', () => {
  const falloff = { start: 25, end: 45, minMultiplier: 0.8 };
  it('is full before the falloff start, reduced after, floored at the minimum', () => {
    expect(damageAt(22, 10, falloff)).toBe(22);
    expect(damageAt(22, 35, falloff)).toBe(20);
    expect(damageAt(22, 100, falloff)).toBe(18);
  });
});

describe('prone hitboxes', () => {
  it('lie along the facing: head in front, legs behind, all low', () => {
    // Facing -Z (yaw 0), shooting from the side (+X) at ground level.
    const side = (z: number, y: number) =>
      rayPlayer([5, y, z], [-1, 0, 0], [0, 0, 0], false, movement, 20, 0);
    expect(side(-0.75, 0.3)?.zone).toBe('head');
    expect(side(-0.2, 0.2)?.zone).toBe('torso');
    expect(side(0.6, 0.12)?.zone).toBe('limbs');
    // A standing chest-height shot passes over them.
    expect(side(0, 1.1)).toBeNull();
    // Standing, the same spot at chest height is a hit.
    expect(rayPlayer([5, 1.1, 0], [-1, 0, 0], [0, 0, 0], false, movement, 20)?.zone).toBe('torso');
  });

  it('turn with the player: facing +X, the head is at +X', () => {
    const quarterRight = 49152; // yaw 3/4 turn: faces +X
    const down = rayPlayer([0.75, 2, 0], [0, -1, 0], [0, 0, 0], false, movement, 5, quarterRight);
    expect(down?.zone).toBe('head');
  });
});
