import { z } from 'zod';

export const ModeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  teams: z.number().int().min(1),
  playersPerTeam: z.number().int().min(1),
  timeLimitSeconds: z.number().int().positive(),
  scoreLimit: z.number().int().positive(),
  /** One line for the Play screen. */
  description: z.string().default(''),
  /** Capture-point rules (Domination); absent for modes without points. */
  capture: z
    .object({
      /** Horizontal radius of a point, metres (and ± this much height). */
      radius: z.number().positive().max(15),
      /** Seconds for an uncontested team to capture a neutral point. */
      seconds: z.number().positive().max(60),
      /** Each point a team holds scores 1 every this many seconds (5: a match lasts minutes). */
      scoreIntervalSeconds: z.number().int().min(1).max(60),
      /** Score per kill (usually small: points decide the match). */
      scorePerKill: z.number().int().min(0).max(10),
    })
    .optional(),
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
    /** Where it is, and a two-line briefing (menus, loading screen). */
    location: z.string().default(''),
    description: z.string().default(''),
    /** Capture points (Domination): A, B, C … placed fairly for both teams. */
    points: z
      .array(z.object({ id: z.string().regex(/^[A-Z]$/), position: Vec3Schema }))
      .max(5)
      .default([]),
    /** Sky, fog and sun preset the client draws the map with. */
    /** Mood: day (high sun), golden (late afternoon, long shadows), dusk. */
    lighting: z.enum(['day', 'golden', 'dusk']).default('day'),
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
    /** Tactical sprint (double-tap sprint): faster than sprint for a while, then a cooldown. */
    tacSprintSpeed: z.number().positive(),
    /** Max 4.25 s each: sent as u8 ticks. */
    tacSprintDuration: z.number().positive().max(4.25),
    tacSprintCooldown: z.number().nonnegative().max(4.25),
    /** Two sprint presses within this many seconds are a double tap. */
    doubleTapWindow: z.number().positive().max(1),
    /** Mantle: Jump while moving forward at a ledge this high (feet to ledge top) climbs it. */
    mantleMinHeight: z.number().positive(),
    mantleMaxHeight: z.number().positive().max(2),
    /** Forward speed while climbing over, m/s. */
    mantleSpeed: z.number().positive(),
    stepHeight: z.number().positive(),
    maxSlopeDeg: z.number().min(0).max(89),
    capsuleRadius: z.number().positive(),
    standingHeight: z.number().positive(),
    crouchHeight: z.number().positive(),
    /**
     * Prone (lying down, Z): capsule height (at least its diameter), crawl speed, and how much
     * steadier the weapon is (spread and recoil multipliers).
     */
    proneHeight: z.number().positive(),
    /** Prone eye above the feet: at the prone head, below the top of the prone hitboxes. */
    proneEyeHeight: z.number().positive().max(0.44),
    proneSpeed: z.number().positive(),
    proneSpread: z.number().min(0.1).max(1),
    proneRecoil: z.number().min(0.1).max(1),
    /** Eye height below the top of the capsule. */
    eyeOffset: z.number().nonnegative(),
  })
  .refine((m) => m.crouchSpeed < m.walkSpeed && m.walkSpeed < m.sprintSpeed, {
    message: 'speeds must satisfy crouch < walk < sprint',
  })
  .refine((m) => m.sprintSpeed < m.tacSprintSpeed, {
    message: 'tactical sprint must be faster than sprint',
  })
  .refine((m) => m.stepHeight < m.mantleMinHeight && m.mantleMinHeight < m.mantleMaxHeight, {
    message: 'mantle heights must satisfy step height < min < max',
  })
  .refine((m) => m.proneHeight < m.crouchHeight && m.proneHeight >= 2 * m.capsuleRadius, {
    message: 'prone height must be below crouch height and at least the capsule diameter',
  })
  .refine((m) => m.proneSpeed < m.crouchSpeed, { message: 'prone must be slower than crouch' })
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
    /**
     * Rays per shot (shotguns). Damage values are per pellet; each pellet gets its own random
     * spread inside `spread` + `pelletSpread`. The server adds up pellet damage per victim.
     */
    pellets: z.number().int().min(1).max(12).default(1),
    pelletSpread: Degrees.default(0),
    magazine: z.number().int().positive().max(255),
    reserve: z.number().int().nonnegative().max(65535),
    reloadTime: z.number().positive().max(4.25),
    equipTime: z.number().positive().max(4.25),
    adsTime: z.number().positive().max(4.25),
    /**
     * Magnifications while aiming down sights, lowest first (1.25 = 1.25×). The mouse wheel
     * steps through them while aiming. Visual only: the view zooms, the shot is the same.
     */
    zoomLevels: z.array(z.number().min(1).max(12)).min(1).max(4),
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
      /**
       * Fraction of the recovery that also happens between shots of a spray (0 = the view only
       * settles after you stop). Small values keep sprays controllable for new players.
       */
      sprayRecovery: z.number().min(0).max(1).default(0),
    }),
    moveSpeedMultiplier: z.number().positive().max(1.5),
    adsMoveSpeedMultiplier: z.number().positive().max(1.5),
    /**
     * Scoped rifles: fully aimed, the view drifts (sway, degrees at its widest). Holding sprint
     * while aimed holds your breath: nearly still for up to `holdBreath` seconds, then the
     * sway is wider for a while (`recover` seconds after a full hold, less after a short one).
     */
    scope: z
      .object({
        sway: z.number().positive().max(3),
        holdBreath: z.number().positive().max(4.25),
        recover: z.number().positive().max(4.25),
      })
      .optional(),
  })
  .refine((w) => w.falloff.end > w.falloff.start, {
    message: 'falloff.end must be beyond falloff.start',
  })
  .refine((w) => w.damage.head >= w.damage.torso && w.damage.torso >= w.damage.limbs, {
    message: 'damage must satisfy head >= torso >= limbs',
  });
export type Weapon = z.infer<typeof WeaponSchema>;

// ---------------------------------------------------------------------------
// Equipment (thrown). Simulated only on the server: a bouncing projectile that explodes
// (frag) or releases a vision-blocking cloud (smoke) when its fuse runs out.
// ---------------------------------------------------------------------------

export const EquipmentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    kind: z.enum(['frag', 'smoke']),
    /** Loadout slot: lethal (G) or tactical (Q). */
    slot: z.enum(['lethal', 'tactical']),
    /** Carried per life. */
    perLife: z.number().int().min(0).max(5),
    /** Seconds after a throw before the next grenade of any kind. */
    cooldown: z.number().nonnegative().max(5).default(0.6),
    /** Launch speed along the view, m/s (plus a little upward lob). */
    throwSpeed: z.number().positive().max(40),
    /** Seconds from the throw until it goes off. */
    fuseTime: z.number().positive().max(10),
    /** Bounciness: fraction of speed kept off a surface (0–1). */
    restitution: z.number().min(0).max(1),
    explosion: z
      .object({
        /** Full damage within innerRadius, falling linearly to minDamage at outerRadius. */
        maxDamage: z.number().int().positive().max(255),
        minDamage: z.number().int().nonnegative().max(255),
        innerRadius: z.number().nonnegative(),
        outerRadius: z.number().positive().max(20),
        /** Damage to the thrower (teammates take none). */
        selfMultiplier: z.number().min(0).max(1),
      })
      .optional(),
    smoke: z
      .object({
        radius: z.number().positive().max(15),
        /** Seconds the cloud lasts once released. */
        duration: z.number().positive().max(30),
      })
      .optional(),
  })
  .refine((e) => (e.kind === 'frag' ? !!e.explosion : !!e.smoke), {
    message: 'frag needs `explosion`, smoke needs `smoke`',
  })
  .refine((e) => !e.explosion || e.explosion.outerRadius > e.explosion.innerRadius, {
    message: 'explosion.outerRadius must be beyond innerRadius',
  });
export type Equipment = z.infer<typeof EquipmentSchema>;

// ---------------------------------------------------------------------------
// Attachments and perks: stat modifiers applied to weapon data when a loadout is built, so the
// simulation (and client prediction) just sees a weapon with different numbers.
// ---------------------------------------------------------------------------

const Mult = z.number().min(0.5).max(1.5);

export const StatModifiersSchema = z
  .object({
    /** Hip-fire and moving spread. */
    spreadHip: Mult,
    spreadMoving: Mult,
    /** Every recoil kick. */
    recoil: Mult,
    adsTime: Mult,
    reloadTime: Mult,
    equipTime: Mult,
    /** Magazine and reserve size (rounded). */
    magazine: Mult,
    /** Damage falloff distances and max range. */
    range: Mult,
    /** Movement speed with the weapon (hip and aiming). */
    moveSpeed: Mult,
    /** Extra spare magazines of reserve ammo. */
    reserveMagazines: z.number().int().min(0).max(3),
  })
  .partial()
  .strict();
export type StatModifiers = z.infer<typeof StatModifiersSchema>;

export const AttachmentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  slot: z.enum(['optic', 'barrel', 'magazine', 'grip', 'stock']),
  /** Weapon classes it fits. */
  classes: z.array(z.enum(['rifle', 'smg', 'shotgun', 'marksman', 'sidearm'])).min(1),
  description: z.string().min(1),
  modifiers: StatModifiersSchema,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const PerkSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Applied to both weapons. */
  modifiers: StatModifiersSchema.default({}),
  /** Server-only: multiplier on frag damage taken. */
  explosiveDamageTaken: z.number().min(0.2).max(1).default(1),
});
export type Perk = z.infer<typeof PerkSchema>;

// ---------------------------------------------------------------------------
// Progression: XP rules, levels and unlocks. Anything not listed in an unlock table is available
// from the start. The API computes XP from server-reported results with these numbers.
// ---------------------------------------------------------------------------

const Level = z.number().int().min(1).max(100);

export const ProgressionSchema = z
  .object({
    xp: z.object({
      participation: z.number().int().nonnegative(),
      perKill: z.number().int().nonnegative(),
      perHeadshot: z.number().int().nonnegative(),
      win: z.number().int().nonnegative(),
      draw: z.number().int().nonnegative(),
    }),
    /** XP to go from level n to n+1 is first + step × (n − 1). */
    levels: z.object({
      max: z.number().int().min(2).max(100),
      first: z.number().int().positive(),
      step: z.number().int().nonnegative(),
    }),
    accountUnlocks: z.array(
      z.object({
        level: Level,
        weapons: z.array(z.string()).default([]),
        perks: z.array(z.string()).default([]),
      }),
    ),
    weaponLevels: z.object({
      /** Kills with a weapon needed for weapon level 1, 2, 3, … (first entry 0). */
      killsForLevel: z.array(z.number().int().nonnegative()).min(1),
      attachmentUnlocks: z.array(
        z.object({ level: Level, attachments: z.array(z.string()).default([]) }),
      ),
    }),
  })
  .refine((p) => p.weaponLevels.killsForLevel[0] === 0, {
    message: 'weapon level 1 must need 0 kills',
  })
  .refine((p) => p.weaponLevels.killsForLevel.every((k, i, a) => i === 0 || k > a[i - 1]!), {
    message: 'killsForLevel must increase',
  });
export type Progression = z.infer<typeof ProgressionSchema>;

// ---------------------------------------------------------------------------
// Challenges: daily and weekly goals, progressed only from server-reported match stats.
// ---------------------------------------------------------------------------

export const ChallengeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  text: z.string().min(1),
  stat: z.enum(['kills', 'headshots', 'wins', 'matches', 'fragKills']),
  /** kills only: count kills with this weapon id. */
  weapon: z.string().optional(),
  target: z.number().int().positive(),
  xp: z.number().int().nonnegative(),
});
export type Challenge = z.infer<typeof ChallengeSchema>;

export const ChallengesSchema = z
  .object({
    dailyCount: z.number().int().min(0).max(10),
    weeklyCount: z.number().int().min(0).max(10),
    daily: z.array(ChallengeSchema),
    weekly: z.array(ChallengeSchema),
  })
  .refine((c) => c.daily.length >= c.dailyCount && c.weekly.length >= c.weeklyCount, {
    message: 'pools must hold at least dailyCount / weeklyCount challenges',
  });

// ---------------------------------------------------------------------------
// Story (menus, briefings). Original setting; see docs/STORY.md.
// ---------------------------------------------------------------------------

export const LoreSchema = z.object({
  premise: z.string().min(1),
  season: z.object({ name: z.string().min(1), text: z.string().min(1) }),
  factions: z
    .array(
      z.object({
        id: z.string(),
        team: z.number().int().min(0).max(1),
        name: z.string().min(1),
        motto: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .length(2),
});
export type Lore = z.infer<typeof LoreSchema>;

// ---------------------------------------------------------------------------
// News: patch notes, loading tips, community links (menu Comms screen)
// ---------------------------------------------------------------------------

export const NewsSchema = z.object({
  community: z.object({
    /** Community invite link; null until one exists (the menu then hides it). */
    discord: z.string().url().startsWith('https://').nullable(),
    feedbackNote: z.string().min(1),
  }),
  /** One is shown on the deploy screen and the first-match tips. */
  tips: z.array(z.string().min(1).max(140)).min(1),
  /** Newest first. */
  patches: z
    .array(
      z.object({
        version: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        title: z.string().min(1),
        notes: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});
export type News = z.infer<typeof NewsSchema>;

// ---------------------------------------------------------------------------
// Kill-streak rewards: earned by kills in one life, decided by the server.
// ---------------------------------------------------------------------------

export const STREAK_REWARDS = ['radar', 'resupply', 'armor'] as const;

export const StreakRewardSchema = z
  .object({
    /** Kills in one life that earn it. */
    kills: z.number().int().min(2).max(30),
    /**
     * radar: the team sees where every enemy is right now (for `seconds`).
     * resupply: full ammo and grenades. armor: damage taken × `damageTaken` for `seconds`.
     */
    reward: z.enum(STREAK_REWARDS),
    name: z.string().min(1),
    seconds: z.number().positive().max(30).optional(),
    damageTaken: z.number().min(0.1).max(1).optional(),
  })
  .refine((s) => s.reward === 'resupply' || s.seconds !== undefined, {
    message: 'radar and armor need seconds',
  })
  .refine((s) => s.reward !== 'armor' || s.damageTaken !== undefined, {
    message: 'armor needs damageTaken',
  });
export type StreakReward = z.infer<typeof StreakRewardSchema>;

// ---------------------------------------------------------------------------
// Feel: how shooting and moving look and feel on your own screen (client only: the gun's kick,
// tracers, camera). Nothing here changes a hit or a number the server decides, so it is not
// part of CONTENT_HASH. The F1 tuning panel edits a live copy and can copy it back as JSON.
// ---------------------------------------------------------------------------

/**
 * The first-person gun's kick on each shot: a spring pulled by every shot and settling back.
 * Distances in metres, angles in degrees (yaw and roll pick a random side per shot).
 */
export const KickSchema = z.object({
  back: z.number().min(0).max(0.2),
  up: z.number().min(0).max(0.1),
  pitch: z.number().min(0).max(20),
  yaw: z.number().min(0).max(10),
  roll: z.number().min(0).max(15),
  /** Spring speed (rad/s): higher snaps back faster. */
  frequency: z.number().min(5).max(80),
  /** 1 = settles without wobble; below 1 wobbles a little. */
  dampingRatio: z.number().min(0.2).max(2),
  /** Kick while aiming, as a fraction of the hip kick. */
  adsScale: z.number().min(0).max(1),
});
export type Kick = z.infer<typeof KickSchema>;

export const FeelSchema = z.object({
  /** Our own tracers: one visible round in every N (1 = every round). */
  tracerEvery: z.number().int().min(1).max(10),
  /** How fast a tracer streak flies (m/s) and how long it looks (m). */
  tracerSpeed: z.number().min(50).max(2000),
  tracerLength: z.number().min(0.2).max(20),
  /** Field of view widening while sprinting and tactical sprinting (degrees). */
  sprintFovBoost: z.number().min(0).max(15),
  tacSprintFovBoost: z.number().min(0).max(20),
  /** Camera roll toward the way you strafe, at full speed (degrees). */
  strafeTilt: z.number().min(0).max(6),
  /** Camera shake from each of our own shots (0 = none). */
  shotShake: z.number().min(0).max(1),
  /** Weapon sway from turning, and walking bob of the gun (1 = as designed). */
  sway: z.number().min(0).max(3),
  gunBob: z.number().min(0).max(3),
  kick: z.record(z.enum(['rifle', 'smg', 'shotgun', 'marksman', 'sidearm']), KickSchema),
  /** Per-weapon kick (by weapon id) instead of its class's. */
  weaponKick: z.record(z.string(), KickSchema).default({}),
});
export type Feel = z.infer<typeof FeelSchema>;

// ---------------------------------------------------------------------------
// Melee: a quick strike with the weapon (V), decided on the server like a shot.
// ---------------------------------------------------------------------------

export const MeleeSchema = z
  .object({
    /** Kill-feed name. */
    name: z.string().min(1),
    /** Reach from the attacker's eyes to the target's chest, metres. */
    range: z.number().positive().max(4),
    /** How far off the view the target may be (degrees from the aim). */
    angleDeg: z.number().positive().max(90),
    /** Damage from the front, and from behind (a back strike is meant to kill outright). */
    damageFront: z.number().int().positive().max(255),
    damageBack: z.number().int().positive().max(255),
    /** Seconds between strikes. */
    cooldown: z.number().positive().max(5),
  })
  .refine((m) => m.damageBack >= m.damageFront, { message: 'damageBack must be >= damageFront' });
export type Melee = z.infer<typeof MeleeSchema>;
