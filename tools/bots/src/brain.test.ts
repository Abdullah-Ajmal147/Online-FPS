import { describe, expect, it } from 'vitest';
import { createRng } from '@sentinel/shared';
import { WanderBrain } from './brain.ts';

describe('bots', () => {
  it('rng is deterministic per seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('wander brain produces valid inputs and actually moves', () => {
    const brain = new WanderBrain(7);
    let moving = 0;
    for (let i = 0; i < 600; i++) {
      const input = brain.next();
      expect(input.yaw).toBeGreaterThanOrEqual(0);
      expect(input.yaw).toBeLessThan(65536);
      if (input.buttons !== 0) moving++;
    }
    expect(moving).toBeGreaterThan(400);
  });
});
