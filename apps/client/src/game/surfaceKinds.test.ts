import { describe, expect, it } from 'vitest';
import { IMPACT, surfaceKind } from './surfaceKinds.ts';

describe('surface kinds', () => {
  it('reads each theme the way it is textured', () => {
    expect(surfaceKind('yard', 'prop')).toBe('metal'); // shipping containers
    expect(surfaceKind('depot', 'wall')).toBe('metal'); // corrugated sheds
    expect(surfaceKind('town', 'wall')).toBe('brick');
    expect(surfaceKind('town', 'stairs')).toBe('wood');
    expect(surfaceKind('yard', 'floor')).toBe('concrete');
  });

  it('gives metal sparks and no chips, and masonry chips', () => {
    expect(IMPACT.metal.sparks).toBeGreaterThan(IMPACT.concrete.sparks);
    expect(IMPACT.metal.chips).toBe(0);
    expect(IMPACT.brick.chips).toBeGreaterThan(0);
  });
});
