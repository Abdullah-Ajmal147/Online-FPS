import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, keyLabel, normalizeSettings, rebind } from './settings.ts';

describe('settings', () => {
  it('falls back to defaults for missing or broken data', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('junk')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ sensitivity: 'fast', fov: Number.NaN })).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps out-of-range numbers', () => {
    const s = normalizeSettings({ sensitivity: 50, fov: 10 });
    expect(s.sensitivity).toBe(0.5);
    expect(s.fov).toBe(70);
  });

  it('keeps valid stored bindings and fills in the rest', () => {
    const s = normalizeSettings({ bindings: { jump: 'KeyF' } });
    expect(s.bindings.jump).toBe('KeyF');
    expect(s.bindings.forward).toBe('KeyW');
  });

  it('rebinding to a key already in use swaps the two actions', () => {
    const b = rebind(DEFAULT_SETTINGS.bindings, 'jump', 'KeyW');
    expect(b.jump).toBe('KeyW');
    expect(b.forward).toBe('Space');
  });

  it('labels keys readably', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ShiftLeft')).toBe('Left Shift');
    expect(keyLabel('Space')).toBe('Space');
  });
});
