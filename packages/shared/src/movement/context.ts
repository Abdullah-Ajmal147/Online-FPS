import type { Movement } from '@sentinel/content';
import { TICK_RATE } from '../constants.ts';
import type { PhysicsWorld, Rapier } from '../physics.ts';

type CharacterController = ReturnType<PhysicsWorld['createCharacterController']>;
type Collider = ReturnType<PhysicsWorld['createCollider']>;
type Capsule = InstanceType<Rapier['Capsule']>;
type CharacterCollision = InstanceType<Rapier['CharacterCollision']>;

/**
 * Gap Rapier keeps between the capsule and the ground/walls. Also used as the distance
 * between the feet position and the bottom of the capsule, so a resting player has feet at y = 0.
 */
export const SKIN = 0.02;

/** Shared per world: the character controller and the movement tuning. */
export interface MovementContext {
  rapier: Rapier;
  world: PhysicsWorld;
  controller: CharacterController;
  tuning: Movement;
  /** Derived once at setup (no trig inside the tick, ADR 0003). */
  walkableNormalY: number;
  slideTicks: number;
  slideCooldownTicks: number;
  tacSprintTicks: number;
  tacSprintCooldownTicks: number;
  doubleTapTicks: number;
  /** Reused every tick to avoid garbage in the 60 Hz loop. */
  scratch: {
    standingCapsule: Capsule;
    /** For getting up from prone into a crouch. */
    crouchCapsule: Capsule;
    collision: CharacterCollision;
    desired: { x: number; y: number; z: number };
    /** Downward ray for ledge probes (origin moved per probe). */
    ray: InstanceType<Rapier['Ray']>;
  };
}

/** One per player: the capsule collider the controller moves. */
export interface PlayerBody {
  collider: Collider;
}

export function createMovementContext(
  rapier: Rapier,
  world: PhysicsWorld,
  tuning: Movement,
): MovementContext {
  const controller = world.createCharacterController(SKIN);
  controller.setUp({ x: 0, y: 1, z: 0 });
  const maxSlope = (tuning.maxSlopeDeg * Math.PI) / 180;
  controller.setMaxSlopeClimbAngle(maxSlope);
  controller.setMinSlopeSlideAngle(maxSlope);
  controller.enableAutostep(tuning.stepHeight, tuning.capsuleRadius * 0.5, false);
  controller.enableSnapToGround(tuning.stepHeight);
  controller.setApplyImpulsesToDynamicBodies(false);
  controller.setSlideEnabled(true);
  return {
    rapier,
    world,
    controller,
    tuning,
    walkableNormalY: Math.cos(maxSlope),
    slideTicks: Math.round(tuning.slideDuration * TICK_RATE),
    slideCooldownTicks: Math.round(tuning.slideCooldown * TICK_RATE),
    tacSprintTicks: Math.round(tuning.tacSprintDuration * TICK_RATE),
    tacSprintCooldownTicks: Math.round(tuning.tacSprintCooldown * TICK_RATE),
    doubleTapTicks: Math.round(tuning.doubleTapWindow * TICK_RATE),
    scratch: {
      standingCapsule: new rapier.Capsule(
        tuning.standingHeight / 2 - tuning.capsuleRadius,
        tuning.capsuleRadius,
      ),
      crouchCapsule: new rapier.Capsule(
        tuning.crouchHeight / 2 - tuning.capsuleRadius,
        tuning.capsuleRadius,
      ),
      collision: new rapier.CharacterCollision(),
      desired: { x: 0, y: 0, z: 0 },
      ray: new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }),
    },
  };
}

/**
 * Player capsules are sensors, and every movement query excludes sensors: players never
 * block each other (Phase 1 decision) and never block themselves.
 */
export function createPlayerBody(ctx: MovementContext): PlayerBody {
  const { capsuleRadius, standingHeight } = ctx.tuning;
  const desc = ctx.rapier.ColliderDesc.capsule(
    standingHeight / 2 - capsuleRadius,
    capsuleRadius,
  ).setSensor(true);
  return { collider: ctx.world.createCollider(desc) };
}

export function removePlayerBody(ctx: MovementContext, body: PlayerBody): void {
  ctx.world.removeCollider(body.collider, false);
}

export function capsuleHeight(tuning: Movement, crouching: boolean, prone = false): number {
  return prone ? tuning.proneHeight : crouching ? tuning.crouchHeight : tuning.standingHeight;
}
