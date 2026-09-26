import { describe, expect, it } from 'vitest';
import { softClipCurve } from './sfx.ts';

/** Output stage: curve index ↔ signal level, as the WaveShaper maps it (input halved first). */
const at = (curve: Float32Array, signal: number) =>
  curve[Math.round(((signal / 2 + 1) / 2) * (curve.length - 1))]!;

describe('output soft clipper', () => {
  const curve = softClipCurve();

  it('leaves normal levels untouched', () => {
    for (const v of [-0.8, -0.5, -0.1, 0, 0.1, 0.5, 0.8]) expect(at(curve, v)).toBeCloseTo(v, 2);
  });

  it('never outputs full scale, even for a signal twice too loud', () => {
    for (const v of [1, 1.05, 1.5, 2]) {
      expect(at(curve, v)).toBeLessThan(0.99);
      expect(at(curve, -v)).toBeGreaterThan(-0.99);
    }
  });

  it('is smooth and rising (no step = no new distortion)', () => {
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
      expect(curve[i]! - curve[i - 1]!).toBeLessThan(0.003);
    }
  });
});
