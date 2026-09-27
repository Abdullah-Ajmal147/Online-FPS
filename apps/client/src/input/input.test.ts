import { describe, expect, it } from 'vitest';
import { Button, MAX_PITCH, TICK_DT, pitchToRadians } from '@sentinel/shared';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { advanceFixedStep, MAX_FRAME_SECONDS } from '../game/fixedStep.ts';
import { verticalFovDegrees, zoomedFovDegrees } from '../camera.ts';
import { buttonsFromKeys, keyTurn } from './keys.ts';
import { applyLook } from './look.ts';
import { radarPoint } from '../game/radar.ts';

const B = DEFAULT_SETTINGS.bindings;

describe('buttonsFromKeys', () => {
  it('maps held keys to button bits', () => {
    expect(buttonsFromKeys(new Set(['KeyW', 'Space']), B, false)).toBe(
      Button.Forward | Button.Jump,
    );
    expect(buttonsFromKeys(new Set(['KeyA', 'KeyC']), B, false)).toBe(Button.Left | Button.Crouch);
    expect(buttonsFromKeys(new Set(['KeyP']), B, false)).toBe(0);
    expect(buttonsFromKeys(new Set(['KeyG', 'KeyQ']), B, false)).toBe(
      Button.Lethal | Button.Tactical,
    );
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

describe('keyTurn', () => {
  const b = DEFAULT_SETTINGS.bindings;
  it('turns left with ArrowLeft and right with ArrowRight at 180°/s', () => {
    expect(keyTurn(new Set(['ArrowLeft']), b, 1)).toBeCloseTo(Math.PI, 10);
    expect(keyTurn(new Set(['ArrowRight']), b, 0.5)).toBeCloseTo(-Math.PI / 2, 10);
  });
  it('works while running (W + Shift held) and cancels when both are held', () => {
    expect(keyTurn(new Set(['KeyW', 'ShiftLeft', 'ArrowLeft']), b, 1)).toBeCloseTo(Math.PI, 10);
    expect(keyTurn(new Set(['ArrowLeft', 'ArrowRight']), b, 1)).toBe(0);
  });
  it('turn keys are not movement buttons', () => {
    expect(buttonsFromKeys(new Set(['ArrowLeft', 'ArrowRight']), b, false)).toBe(0);
  });
});

describe('zoomedFovDegrees', () => {
  it('is the same view at 1×, and makes things m times bigger at m×', () => {
    expect(zoomedFovDegrees(90, 1)).toBeCloseTo(90, 10);
    // 2× at 90°: tan(45°) = 1 → tan(half) = 0.5 → 53.13°.
    expect(zoomedFovDegrees(90, 2)).toBeCloseTo(53.13, 2);
    const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);
    expect(tanHalf(90) / tanHalf(zoomedFovDegrees(90, 8))).toBeCloseTo(8, 10);
  });
});

describe('radarPoint', () => {
  it('puts what is ahead at the top and what is to the right on the right, for any yaw', () => {
    // Facing -Z (yaw 0): an enemy 10 m ahead is straight up; 10 m to +X is to the right.
    const [ax, ay] = radarPoint(0, -10, 0, 1);
    expect(ax).toBeCloseTo(0, 10);
    expect(ay).toBeCloseTo(-10, 10);
    expect(radarPoint(10, 0, 0, 1)[0]).toBeCloseTo(10, 10);
    // Turned a quarter left (facing -X): an enemy at -X is ahead, one at -Z is to the right.
    const [bx, by] = radarPoint(-10, 0, Math.PI / 2, 1);
    expect(bx).toBeCloseTo(0, 10);
    expect(by).toBeCloseTo(-10, 10);
    expect(radarPoint(0, -10, Math.PI / 2, 2)[0]).toBeCloseTo(20, 10);
  });
});
