import { describe, expect, it } from 'vitest';
import { Button, MAX_PITCH, TICK_DT, pitchToRadians } from '@sentinel/shared';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { advanceFixedStep, MAX_FRAME_SECONDS } from '../game/fixedStep.ts';
import { verticalFovDegrees } from '../camera.ts';
import { buttonsFromKeys } from './keys.ts';
import { applyLook } from './look.ts';

const B = DEFAULT_SETTINGS.bindings;

describe('buttonsFromKeys', () => {
  it('maps held keys to button bits', () => {
    expect(buttonsFromKeys(new Set(['KeyW', 'Space']), B, false)).toBe(
      Button.Forward | Button.Jump,
    );
    expect(buttonsFromKeys(new Set(['KeyA', 'KeyC']), B, false)).toBe(Button.Left | Button.Crouch);
    expect(buttonsFromKeys(new Set(['KeyQ']), B, false)).toBe(0);
  });

  it('sprint comes from the latch the caller tracks (hold or toggle)', () => {
    expect(buttonsFromKeys(new Set(['KeyW']), B, true)).toBe(Button.Forward | Button.Sprint);
    expect(buttonsFromKeys(new Set(['KeyW', 'ShiftLeft']), B, false)).toBe(Button.Forward);
  });

  it('follows rebinding', () => {
    expect(buttonsFromKeys(new Set(['ArrowUp']), { ...B, forward: 'ArrowUp' }, false)).toBe(
      Button.Forward,
    );
  });
});

describe('applyLook', () => {
  it('turns right when the mouse moves right, at degrees per count', () => {
    const look = applyLook({ yaw: 1, pitch: 0 }, 100, 0, 0.1); // 10 degrees right
    expect(look.yaw).toBeCloseTo(1 - (10 * Math.PI) / 180, 10);
  });

  it('wraps yaw into [0, 2π)', () => {
    expect(applyLook({ yaw: 0.01, pitch: 0 }, 100, 0, 0.1).yaw).toBeGreaterThan(6);
  });

  it('looks down when the mouse moves down and clamps pitch', () => {
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, 10, 0.1).pitch).toBeLessThan(0);
    const max = pitchToRadians(MAX_PITCH);
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, -100000, 0.1).pitch).toBeCloseTo(max, 10);
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, 100000, 0.1).pitch).toBeCloseTo(-max, 10);
  });
});

describe('advanceFixedStep', () => {
  it('runs one tick per 1/60 s regardless of frame rate', () => {
    let acc = 0;
    let ticks = 0;
    for (let i = 0; i < 144; i++) {
      const r = advanceFixedStep(acc, 1 / 144); // one second at 144 Hz
      acc = r.accumulator;
      ticks += r.ticks;
    }
    expect(ticks).toBeGreaterThanOrEqual(59);
    expect(ticks).toBeLessThanOrEqual(60);
  });

  it('caps catch-up after a long stall', () => {
    expect(advanceFixedStep(0, 5).ticks).toBe(Math.floor(MAX_FRAME_SECONDS / TICK_DT));
  });

  it('returns interpolation alpha in [0, 1)', () => {
    const r = advanceFixedStep(0, TICK_DT * 1.5);
    expect(r.ticks).toBe(1);
    expect(r.alpha).toBeCloseTo(0.5, 6);
  });
});

describe('verticalFovDegrees', () => {
  it('equals the horizontal FOV at aspect 1', () => {
    expect(verticalFovDegrees(90, 1)).toBeCloseTo(90, 10);
  });

  it('gives the standard 59° vertical for 90° horizontal at 16:9', () => {
    expect(verticalFovDegrees(90, 16 / 9)).toBeCloseTo(58.72, 1);
  });

  it('shrinks as the screen gets wider', () => {
    expect(verticalFovDegrees(90, 21 / 9)).toBeLessThan(verticalFovDegrees(90, 16 / 9));
  });
});
