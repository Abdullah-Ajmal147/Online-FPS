import { describe, expect, it } from 'vitest';
import { detSinCos } from './detmath.ts';

describe('detSinCos', () => {
  it('matches Math.sin/cos closely at every 97th angle', () => {
    for (let a = 0; a < 65536; a += 97) {
      const [s, c] = detSinCos(a);
      const rad = (a / 65536) * 2 * Math.PI;
      expect(Math.abs(s - Math.sin(rad))).toBeLessThan(1e-12);
      expect(Math.abs(c - Math.cos(rad))).toBeLessThan(1e-12);
    }
  });

  it('is exact at the quarter turns', () => {
    expect(detSinCos(0)).toEqual([0, 1]);
    expect(detSinCos(16384)).toEqual([1, -0]);
    expect(detSinCos(32768)).toEqual([-0, -1]);
    expect(detSinCos(49152)).toEqual([-1, 0]);
  });

  it('wraps angles outside 0..65535', () => {
    expect(detSinCos(65536 + 1000)).toEqual(detSinCos(1000));
    expect(detSinCos(-1)).toEqual(detSinCos(65535));
  });
});
