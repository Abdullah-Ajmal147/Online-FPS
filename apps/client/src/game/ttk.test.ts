import { describe, expect, it } from 'vitest';
import { weaponCatalog } from '@sentinel/content';
import { ttk } from './ttk.ts';

const byId = (id: string) => weaponCatalog.find((w) => w.id === id)!;

describe('ttk', () => {
  it('counts shots and time between the first and last shot', () => {
    // Kestrel AR: 22 torso → 5 shots, 4 gaps at 600 rpm (100 ms) = 400 ms.
    expect(ttk(byId('kestrel-ar'), 10)).toMatchObject({ bodyShots: 5, bodyMs: 400 });
    // Heads: 40 → 3 shots, 200 ms.
    expect(ttk(byId('kestrel-ar'), 10)).toMatchObject({ headShots: 3, headMs: 200 });
  });

  it('applies range falloff, and adds up shotgun pellets', () => {
    const near = ttk(byId('kestrel-ar'), 10).bodyShots;
    expect(ttk(byId('kestrel-ar'), 80).bodyShots).toBeGreaterThanOrEqual(near);
    // Thresher-12: 8 pellets × 14 up close = 112: one shot.
    expect(ttk(byId('thresher-12'), 3)).toMatchObject({ bodyShots: 1, bodyMs: 0 });
  });
});
