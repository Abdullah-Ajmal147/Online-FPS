import { describe, expect, it } from 'vitest';
import { MAP_ROTATION } from '@sentinel/content';
import { mapRotationFromEnv } from './mapRotation.ts';

describe('mapRotationFromEnv', () => {
  it('defaults to the content rotation', () => {
    expect(mapRotationFromEnv({})).toEqual(MAP_ROTATION);
  });

  it('SENTINEL_MAP pins one map; SENTINEL_MAP_ROTATION sets the list', () => {
    expect(mapRotationFromEnv({ SENTINEL_MAP: 'arena' })).toEqual(['arena']);
    expect(mapRotationFromEnv({ SENTINEL_MAP_ROTATION: ' saltline-depot , relay-yard,' })).toEqual([
      'saltline-depot',
      'relay-yard',
    ]);
    expect(mapRotationFromEnv({ SENTINEL_MAP_ROTATION: 'relay-yard' })).toEqual(['relay-yard']);
  });

  it('refuses unknown maps at startup', () => {
    expect(() => mapRotationFromEnv({ SENTINEL_MAP_ROTATION: 'relay-yard,nowhere' })).toThrow(
      /nowhere/,
    );
    expect(() => mapRotationFromEnv({ SENTINEL_MAP: 'constructor' })).toThrow();
  });
});
