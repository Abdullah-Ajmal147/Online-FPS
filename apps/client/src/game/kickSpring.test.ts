import { describe, expect, it } from 'vitest';
import { feel } from '@sentinel/content';
import { KickSpring } from './kickSpring.ts';

const rifle = feel.kick.rifle;

function peakBack(spring: KickSpring, seconds: number): number {
  let peak = 0;
  for (let t = 0; t < seconds; t += 1 / 1000) {
    spring.update(1 / 1000, rifle);
    peak = Math.max(peak, spring.offset[0]!);
  }
  return peak;
}

describe('KickSpring', () => {
  it('one shot peaks at the configured kick and settles back', () => {
    const s = new KickSpring();
    s.fire(rifle, 0, 1, 1);
    expect(peakBack(s, 1)).toBeCloseTo(rifle.back, 3);
    expect(Math.abs(s.offset[0]!)).toBeLessThan(rifle.back * 0.02);
  });

  it('aiming scales the kick by adsScale', () => {
    const s = new KickSpring();
    s.fire(rifle, 1, 1, 1);
    expect(peakBack(s, 1)).toBeCloseTo(rifle.back * rifle.adsScale, 3);
  });

  it('a spray stacks kicks higher than one shot, and is the same at any frame rate', () => {
    const run = (dt: number) => {
      const s = new KickSpring();
      let peak = 0;
      for (let t = 0, next = 0; t < 0.5; t += dt) {
        if (t >= next) {
          s.fire(rifle, 0, 1, -1);
          next += 0.1;
        }
        s.update(dt, rifle);
        peak = Math.max(peak, s.offset[2]!);
      }
      return peak;
    };
    const at60 = run(1 / 60);
    expect(at60).toBeGreaterThan((rifle.pitch * Math.PI) / 180);
    expect(run(1 / 144)).toBeCloseTo(at60, 2);
  });
});
