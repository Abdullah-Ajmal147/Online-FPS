import { z } from 'zod';

export const ModeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  teams: z.number().int().min(1),
  playersPerTeam: z.number().int().min(1),
  timeLimitSeconds: z.number().int().positive(),
  scoreLimit: z.number().int().positive(),
});

export type Mode = z.infer<typeof ModeSchema>;

// ---------------------------------------------------------------------------
// Maps. Units are metres, +Y is up. Yaw 0 faces -Z; positive yaw turns left (towards -X).
// ---------------------------------------------------------------------------

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const PositiveVec3Schema = z.tuple([
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
]);

/**
 * Map geometry is only rotated in quarter turns. That keeps rotations exact
 * (swap/negate, no Math.sin), so every browser and the server build bit-identical colliders.
 */
const QuarterYawSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

/** Maps must fit within ±500 m on every axis (wire format limit is ±511 m, see ADR 0004). */
export const MAP_EXTENT_METRES = 500;

export const MaterialSchema = z.enum(['floor', 'wall', 'prop', 'ramp', 'stairs', 'platform']);
export type Material = z.infer<typeof MaterialSchema>;

const BoxPrimitiveSchema = z.object({
  kind: z.literal('box'),
  center: Vec3Schema,
  size: PositiveVec3Schema,
  yawDeg: QuarterYawSchema.default(0),
  material: MaterialSchema.default('prop'),
});

/** Solid wedge. `base` is the centre of the low edge; the ramp climbs along its local -Z (forward). */
const RampPrimitiveSchema = z.object({
  kind: z.literal('ramp'),
  base: Vec3Schema,
  width: z.number().positive(),
  run: z.number().positive(),
  rise: z.number().positive(),
  yawDeg: QuarterYawSchema.default(0),
  material: MaterialSchema.default('ramp'),
});

/** Solid staircase. `start` is the centre of the bottom front edge; it climbs along local -Z. */
const StairsPrimitiveSchema = z.object({
  kind: z.literal('stairs'),
  start: Vec3Schema,
  width: z.number().positive(),
  steps: z.number().int().min(1).max(64),
  stepRise: z.number().positive(),
  stepDepth: z.number().positive(),
  yawDeg: QuarterYawSchema.default(0),
  material: MaterialSchema.default('stairs'),
});

export const PrimitiveSchema = z.discriminatedUnion('kind', [
  BoxPrimitiveSchema,
  RampPrimitiveSchema,
  StairsPrimitiveSchema,
]);
export type Primitive = z.infer<typeof PrimitiveSchema>;

export const SpawnSchema = z.object({
  team: z.number().int().min(0),
  position: Vec3Schema,
  yawDeg: z.number(),
});

export const MapSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    /** Anything below this height counts as fallen out of the map. */
    killY: z.number(),
    geometry: z.array(PrimitiveSchema).min(1),
    spawns: z.array(SpawnSchema).min(2),
  })
  .refine((m) => [0, 1].every((team) => m.spawns.some((s) => s.team === team)), {
    message: 'every team needs at least one spawn',
  })
  // Other players' positions go on the wire as int16 at 1/64 m (ADR 0004): ±511 m.
  .refine(
    (m) =>
      [
        ...m.spawns.map((s) => s.position),
        ...m.geometry.map((g) =>
          g.kind === 'box' ? g.center : g.kind === 'ramp' ? g.base : g.start,
        ),
      ].every((p) => p.every((v) => Math.abs(v) <= MAP_EXTENT_METRES)),
    { message: `map must fit within ±${500} m` },
  );
export type GameMap = z.infer<typeof MapSchema>;

// ---------------------------------------------------------------------------
// Movement tuning. Read by packages/shared/movement; no speeds are hard-coded in logic.
// ---------------------------------------------------------------------------

export const MovementSchema = z
  .object({
    walkSpeed: z.number().positive(),
    sprintSpeed: z.number().positive(),
    crouchSpeed: z.number().positive(),
    /** Ground acceleration and friction, in m/s². */
    groundAccel: z.number().positive(),
    groundFriction: z.number().nonnegative(),
    /** Fraction of ground acceleration available in the air (0 = none, 1 = full). */
    airControl: z.number().min(0).max(1),
    gravity: z.number().positive(),
    jumpHeight: z.number().positive(),
    /** Max 4.25 s: slide ticks are sent as a u8 (255 ticks at 60 Hz). */
    slideDuration: z.number().positive().max(4.25),
    /** Speed at the start of a slide, as a multiple of sprintSpeed. */
    slideBoost: z.number().min(1),
    slideFriction: z.number().nonnegative(),
    /** Seconds after a slide ends before another can start (stops crouch-spam slides). */
    slideCooldown: z.number().nonnegative().max(4.25),
    stepHeight: z.number().positive(),
    maxSlopeDeg: z.number().min(0).max(89),
    capsuleRadius: z.number().positive(),
    standingHeight: z.number().positive(),
    crouchHeight: z.number().positive(),
    /** Eye height below the top of the capsule. */
    eyeOffset: z.number().nonnegative(),
  })
  .refine((m) => m.crouchSpeed < m.walkSpeed && m.walkSpeed < m.sprintSpeed, {
    message: 'speeds must satisfy crouch < walk < sprint',
  })
  .refine((m) => m.crouchHeight < m.standingHeight && m.standingHeight > 2 * m.capsuleRadius, {
    message:
      'crouch height must be below standing height, and both taller than the capsule diameter',
  });
export type Movement = z.infer<typeof MovementSchema>;

// ---------------------------------------------------------------------------
// Weapons. Units: damage in HP, distances in metres, times in seconds, angles in degrees.
// packages/shared converts these to ticks and 16-bit angle units once at load.
// ---------------------------------------------------------------------------

const Degrees = z.number().nonnegative().max(45);

export const WeaponSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    class: z.enum(['rifle', 'smg', 'shotgun', 'marksman', 'sidearm']),
    /** Loadout slot: 0 = primary, 1 = secondary. */
    slot: z.union([z.literal(0), z.literal(1)]),
    fireMode: z.enum(['auto', 'semi']),
    /** Rounds per minute. At most 3600 (one shot per 60 Hz tick). */
    rpm: z.number().min(15).max(3600), // ≥ 15 keeps the cooldown within its u8 wire field
    damage: z.object({
      head: z.number().int().positive().max(255),
      torso: z.number().int().positive().max(255),
      limbs: z.number().int().positive().max(255),
    }),
    falloff: z.object({
      start: z.number().nonnegative(),
      end: z.number().positive(),
      minMultiplier: z.number().min(0).max(1),
    }),
    maxRange: z.number().positive().max(500),
    magazine: z.number().int().positive().max(255),
    reserve: z.number().int().nonnegative().max(65535),
    reloadTime: z.number().positive().max(4.25),
    equipTime: z.number().positive().max(4.25),
    adsTime: z.number().positive().max(4.25),
    spread: z.object({
      hip: Degrees,
      ads: Degrees,
      moving: Degrees,
      airborne: Degrees,
      perShot: Degrees,
      max: Degrees,
      recoveryPerSecond: z.number().nonnegative(),
    }),
    recoil: z.object({
      /** Per shot: [up, right] kick in degrees. After the last entry the last one repeats. */
      pattern: z
        .array(z.tuple([z.number().min(-10).max(10), z.number().min(-10).max(10)]))
        .min(1)
        .max(255),
      adsMultiplier: z.number().min(0).max(2),
      recoveryPerSecond: z.number().nonnegative(),
    }),
    moveSpeedMultiplier: z.number().positive().max(1.5),
    adsMoveSpeedMultiplier: z.number().positive().max(1.5),
  })
  .refine((w) => w.falloff.end > w.falloff.start, {
    message: 'falloff.end must be beyond falloff.start',
  })
  .refine((w) => w.damage.head >= w.damage.torso && w.damage.torso >= w.damage.limbs, {
    message: 'damage must satisfy head >= torso >= limbs',
  });
export type Weapon = z.infer<typeof WeaponSchema>;
