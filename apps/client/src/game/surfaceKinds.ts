import type { Material } from '@sentinel/content';
import type { Theme } from '../map.ts';

/** What a surface is made of, as far as bullets and feet can tell (impacts, marks, sounds). */
export type SurfaceKind = 'concrete' | 'metal' | 'brick' | 'wood';

/**
 * Per map theme, what each map material looks like (tools/assets/surfaces.json): the yard is
 * asphalt and concrete with steel props, the depot is corrugated steel sheds on concrete, the
 * town is paving, brick and timber.
 */
const KINDS: Record<Theme, Record<Material, SurfaceKind>> = {
  yard: {
    floor: 'concrete',
    wall: 'concrete',
    prop: 'metal',
    ramp: 'metal',
    stairs: 'metal',
    platform: 'metal',
  },
  depot: {
    floor: 'concrete',
    wall: 'metal',
    prop: 'metal',
    ramp: 'metal',
    stairs: 'metal',
    platform: 'concrete',
  },
  town: {
    floor: 'concrete',
    wall: 'brick',
    prop: 'metal',
    ramp: 'brick',
    stairs: 'wood',
    platform: 'wood',
  },
};

export function surfaceKind(theme: Theme, material: Material): SurfaceKind {
  return KINDS[theme][material];
}

/**
 * How a bullet hit on each kind looks: dust colour and size, chips (colour, count), sparks,
 * the mark's tint and size (metres).
 */
export const IMPACT: Record<
  SurfaceKind,
  {
    dust: number;
    dustSize: number;
    chips: number;
    chipColor: number;
    sparks: number;
    mark: number;
    markSize: number;
  }
> = {
  concrete: {
    dust: 0xb9b2a6,
    dustSize: 1,
    chips: 4,
    chipColor: 0x8d8a84,
    sparks: 1,
    mark: 0x1a1b1d,
    markSize: 1,
  },
  metal: {
    dust: 0x9c9890,
    dustSize: 0.45,
    chips: 0,
    chipColor: 0,
    sparks: 7,
    mark: 0xd8d4cc, // bright bare metal where the paint came off
    markSize: 0.7,
  },
  brick: {
    dust: 0xb4735a,
    dustSize: 1.1,
    chips: 5,
    chipColor: 0x8a4a36,
    sparks: 0,
    mark: 0x2a1812,
    markSize: 1.1,
  },
  wood: {
    dust: 0xa08866,
    dustSize: 0.7,
    chips: 6,
    chipColor: 0xc19a6b, // splinters: pale fresh wood
    sparks: 0,
    mark: 0x21160d,
    markSize: 0.9,
  },
};
