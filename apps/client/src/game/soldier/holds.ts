import type { Weapon } from '@sentinel/content';

/** Weapon models (tools/assets/guns.json), one per weapon class. */
export type WeaponModelId = 'rifle' | 'smg' | 'shotgun' | 'marksman' | 'sidearm';

export const MODEL_FOR_CLASS: Record<Weapon['class'], WeaponModelId> = {
  rifle: 'rifle',
  smg: 'smg',
  shotgun: 'shotgun',
  marksman: 'marksman',
  sidearm: 'sidearm',
};

/**
 * How a soldier holds each weapon. Weapon space: -Z = barrel, +Y = up, +X = right, origin at the
 * middle of the model. Tuned by eye in the model lab (/lab.html?view=hold).
 */
export interface Hold {
  /** Weapon centre from the chest bone, along the aim: [right, up, forward] metres. */
  at: [number, number, number];
  /** Right and left wrist positions in weapon space (the hands wrap the grips from there). */
  right: [number, number, number];
  left: [number, number, number];
  /** Extra turn of the left hand (radians, XYZ) so it cups the handguard. */
  leftTwist: [number, number, number];
  /** Muzzle point in weapon space (y, z). */
  muzzle: [number, number, number];
  /** How far a shot kicks it back (m). */
  kick: number;
  /** First person: sight line below the model's top (m), and the weapon centre's distance in
   * front of the eye when aiming down the sights (m, negative = forward). `scale`: drawn
   * larger in first person (the pistol, to suit the viewmodel's larger-than-life hands). */
  fp: { sightDrop: number; z: number; scale?: number };
}

export const HOLDS: Record<WeaponModelId, Hold> = {
  rifle: {
    at: [0.13, 0.12, 0.33],
    right: [0.02, -0.05, 0.19],
    left: [-0.02, -0.04, -0.12],
    leftTwist: [0, 0, 0],
    muzzle: [0, 0.03, -0.44],
    kick: 0.04,
    fp: { sightDrop: -0.004, z: -0.46 },
  },
  smg: {
    at: [0.12, 0.11, 0.3],
    right: [0.02, -0.06, 0.08],
    left: [-0.02, -0.1, -0.02],
    leftTwist: [0, 0, 0],
    muzzle: [0, 0.03, -0.3],
    kick: 0.03,
    fp: { sightDrop: 0.0, z: -0.36 },
  },
  shotgun: {
    at: [0.13, 0.12, 0.36],
    right: [0.02, -0.05, 0.2],
    left: [-0.02, -0.05, -0.2],
    leftTwist: [0, 0, 0],
    muzzle: [0, 0.03, -0.5],
    kick: 0.07,
    fp: { sightDrop: 0.0, z: -0.52 },
  },
  marksman: {
    at: [0.13, 0.12, 0.4],
    right: [0.02, -0.05, 0.22],
    left: [-0.02, -0.04, -0.15],
    leftTwist: [0, 0, 0],
    muzzle: [0, 0.02, -0.56],
    kick: 0.05,
    fp: { sightDrop: 0.028, z: -0.6 },
  },
  sidearm: {
    at: [0.02, 0.15, 0.42],
    right: [0.0, -0.06, 0.07],
    left: [-0.03, -0.07, 0.07],
    leftTwist: [0, 0, 0],
    muzzle: [0, 0.03, -0.1],
    kick: 0.03,
    fp: { sightDrop: 0.0, z: -0.46, scale: 1.35 },
  },
};
