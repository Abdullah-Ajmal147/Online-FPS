import { TICK_DT, TICK_RATE } from '../constants.ts';
import { detSinCos } from '../detmath.ts';
import { Button, sanitizeInput, type PlayerInput } from '../input.ts';
import type { Vec3 } from '../map/solids.ts';
import { SKIN, capsuleHeight, type MovementContext, type PlayerBody } from './context.ts';
import type { PlayerState } from './state.ts';

const f = Math.fround;
/** A mantle hop rises this much above the ledge, so the capsule's bottom clears the edge. */
const MANTLE_CLEARANCE = 0.15;
/** Mantle ticks after the top of the hop: time to move over the ledge before air rules. */
const MANTLE_EXTRA_TICKS = 12;
/** How far ahead of the capsule's surface we look for a ledge, metres. */
const LEDGE_PROBES = [0.1, 0.3, 0.5, 0.7];
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Advance one player by one fixed tick (1/60 s). The same function runs on the server
 * (authoritative) and in the client (prediction), so given the same state and input it must
 * give the same result everywhere:
 *   - the collider is placed from `state` at the start, so no hidden state carries over;
 *   - trig uses detSinCos, not Math.sin;
 *   - position and velocity are rounded to float32 at the end (ADR 0003).
 * The input is sanitized here, because on the server it comes straight from the network.
 */
export function step(
  prev: PlayerState,
  rawInput: PlayerInput,
  ctx: MovementContext,
  body: PlayerBody,
  /** Held weapon's speed multiplier (aiming slows you). Not applied to slides. */
  speedScale = 1,
): PlayerState {
  const input = sanitizeInput(rawInput);
  const t = ctx.tuning;
  const dt = TICK_DT;
  const held = input.buttons;
  const pressed = held & ~prev.prevButtons;

  // --- Wish direction from buttons and yaw. Yaw 0 faces -Z; forward = (-sin, 0, -cos). ---
  const [sinY, cosY] = detSinCos(input.yaw);
  const fwd = (held & Button.Forward ? 1 : 0) - (held & Button.Back ? 1 : 0);
  const side = (held & Button.Right ? 1 : 0) - (held & Button.Left ? 1 : 0);
  let wishX = -sinY * fwd + cosY * side;
  let wishZ = -cosY * fwd - sinY * side;
  const wishLen = Math.sqrt(wishX * wishX + wishZ * wishZ);
  const hasWish = wishLen > 0;
  if (hasWish) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  let [vx, vy, vz] = prev.velocity;
  let crouching = prev.crouching;
  let prone = prev.prone;
  let slideTicks = prev.slideTicks;
  let slideCooldownTicks = Math.max(0, prev.slideCooldownTicks - 1);
  const hSpeed = Math.sqrt(vx * vx + vz * vz);
  const sprintHeld = (held & Button.Sprint) !== 0 && fwd > 0;
  let mantleTicks = prev.mantleTicks;
  let mantleYaw = prev.mantleYaw;
  let tacSprintTicks = prev.tacSprintTicks;
  let tacCooldownTicks = Math.max(0, prev.tacCooldownTicks - 1);
  let sprintTapTicks = Math.max(0, prev.sprintTapTicks - 1);

  // --- Prone (Z): lie down on the ground, or get up. Jump, sprint (forward) or crouch also get
  // you up: standing if there is room, else crouched (crouch goes to a crouch), else you stay
  // down (under a low bar there is no getting up).
  const getUp =
    prone &&
    ((pressed & Button.Prone) !== 0 ||
      (pressed & Button.Jump) !== 0 ||
      (pressed & Button.Crouch) !== 0 ||
      ((pressed & Button.Sprint) !== 0 && fwd > 0));
  if (getUp) {
    const toCrouch = (held & Button.Crouch) !== 0;
    if (
      !toCrouch &&
      hasRoom(prev.position, ctx, body, ctx.scratch.standingCapsule, t.standingHeight)
    ) {
      prone = false;
      crouching = false;
    } else if (hasRoom(prev.position, ctx, body, ctx.scratch.crouchCapsule, t.crouchHeight)) {
      prone = false;
      crouching = true;
    }
  } else if (!prone && pressed & Button.Prone && prev.grounded && prev.mantleTicks === 0) {
    prone = true;
    crouching = false;
    slideTicks = 0;
  }

  // --- Crouch / stand. Standing up needs head room. Releasing crouch ends a slide. ---
  if (prone) {
    // Lying down: crouch and slide don't apply.
  } else if (held & Button.Crouch) {
    crouching = true;
  } else {
    slideTicks = 0;
    if (crouching && hasHeadroom(prev.position, ctx, body)) crouching = false;
  }

  // --- Tactical sprint: double-tap sprint (two presses within doubleTapWindow). ---
  // Lasts while sprint + forward stay held, up to tacSprintDuration; then a cooldown. The
  // weapon counts it as sprinting (lowered, can't fire), like normal sprint.
  if (pressed & Button.Sprint) {
    if (sprintTapTicks > 0 && tacCooldownTicks === 0 && tacSprintTicks === 0 && fwd > 0) {
      tacSprintTicks = ctx.tacSprintTicks;
      sprintTapTicks = 0;
    } else {
      sprintTapTicks = ctx.doubleTapTicks;
    }
  }
  if (tacSprintTicks > 0 && (!sprintHeld || crouching || prone)) tacSprintTicks = 0;

  // --- Slide: press crouch while grounded and sprinting forward at sprint pace. ---
  // Needs Sprint + Forward held and no cooldown, so tapping crouch cannot chain slides.
  if (
    prev.grounded &&
    !prone &&
    !prev.prone &&
    pressed & Button.Crouch &&
    sprintHeld &&
    slideTicks === 0 &&
    slideCooldownTicks === 0 &&
    hSpeed >= (t.walkSpeed + t.sprintSpeed) / 2
  ) {
    slideTicks = ctx.slideTicks;
    const scale = (t.sprintSpeed * t.slideBoost) / hSpeed;
    vx *= scale;
    vz *= scale;
  }
  const wasSliding = slideTicks > 0;

  // --- Jump: on press only (holding jump does not bunny-hop). Cancels a slide. ---
  // Moving forward at a waist-to-chest-high ledge, the jump becomes a mantle: a hop sized to
  // just clear the ledge plus a forward push each tick, so the controller carries us up the
  // wall and over the top. Same ray/shape queries on client and server (deterministic).
  let jumped = false;
  if (prev.grounded && pressed & Button.Jump && !prone && !prev.prone) {
    const ledge = fwd > 0 && !crouching ? findLedge(prev.position, sinY, cosY, ctx) : null;
    if (ledge !== null) {
      vy = Math.sqrt(2 * t.gravity * (ledge + MANTLE_CLEARANCE));
      mantleTicks = Math.min(255, Math.ceil((vy / t.gravity) * TICK_RATE) + MANTLE_EXTRA_TICKS);
      mantleYaw = input.yaw; // the push keeps this direction: turning can't steer the climb
    } else {
      vy = Math.sqrt(2 * t.gravity * t.jumpHeight);
    }
    jumped = true;
    slideTicks = 0;
  } else if (mantleTicks > 0 && (prev.grounded || held & Button.Crouch)) {
    mantleTicks = 0; // landed on top, or let go (crouch)
  }

  // --- Horizontal velocity. ---
  // A jump tick still uses ground rules, so chained hops are pulled back to normal speed.
  // Only a jump straight out of a slide keeps the slide's speed (for that one hop).
  const groundRules = prev.grounded && !(jumped && wasSliding);
  if (mantleTicks > 0) {
    // Mantling: push along the direction the mantle started in (walls clip this each tick;
    // it is re-applied), where findLedge checked there is room to stand.
    const [sinM, cosM] = detSinCos(mantleYaw);
    vx = -sinM * t.mantleSpeed;
    vz = -cosM * t.mantleSpeed;
    mantleTicks -= 1;
  } else if (slideTicks > 0 && prev.grounded && !jumped) {
    // Sliding: no steering, constant friction, ends early if too slow.
    const speed = Math.sqrt(vx * vx + vz * vz);
    const newSpeed = Math.max(0, speed - t.slideFriction * dt);
    const k = speed > 0 ? newSpeed / speed : 0;
    vx *= k;
    vz *= k;
    slideTicks -= 1;
    if (newSpeed < t.crouchSpeed) slideTicks = 0;
  } else {
    if (!prev.grounded) slideTicks = 0;
    const sprinting = sprintHeld && !crouching && !prone;
    const sprintSpeed = tacSprintTicks > 0 ? t.tacSprintSpeed : t.sprintSpeed;
    let target =
      (prone ? t.proneSpeed : crouching ? t.crouchSpeed : sprinting ? sprintSpeed : t.walkSpeed) *
      speedScale;
    if (groundRules) {
      // Accelerate towards the wish velocity; with no input, friction brings us to a stop.
      [vx, vz] = approach(
        vx,
        vz,
        wishX * target,
        wishZ * target,
        hasWish ? t.groundAccel : t.groundFriction,
        dt,
      );
    } else if (hasWish) {
      // Air control: steer without bleeding speed gained from a slide or jump.
      target = Math.max(target, Math.sqrt(vx * vx + vz * vz));
      [vx, vz] = approach(vx, vz, wishX * target, wishZ * target, t.groundAccel * t.airControl, dt);
    }
  }
  // Any slide that ended this tick (ran out, cancelled, released, left the ground) starts the cooldown.
  if (prev.slideTicks > 0 && slideTicks === 0) slideCooldownTicks = ctx.slideCooldownTicks;
  // Tactical sprint counts down while running; when it ends for any reason, the cooldown starts.
  if (tacSprintTicks > 0) tacSprintTicks -= 1; // counts the start tick too: exactly the duration
  if (prev.tacSprintTicks > 0 && tacSprintTicks === 0)
    tacCooldownTicks = ctx.tacSprintCooldownTicks;

  // --- Gravity. ---
  // While grounded we do NOT push down: gravity would sink the capsule into Rapier's skin
  // every tick, and from inside the skin its horizontal sweep hits the floor and stalls.
  // Snap-to-ground keeps us on down-slopes and stairs instead.
  // Displacement uses the average of start and end velocity (exact for constant gravity),
  // so the jump apex matches the tuned jump height.
  const vyStart = vy;
  if (!jumped && prev.grounded) {
    vy = 0;
  } else {
    vy -= t.gravity * dt;
  }
  const dy = prev.grounded && !jumped ? 0 : ((vyStart + vy) / 2) * dt;

  // --- Move the capsule with Rapier's character controller. ---
  const height = capsuleHeight(t, crouching, prone);
  placeCollider(prev.position, height, ctx, body);
  // No autostep while mantling: the hop alone decides how high we get (ledge + clearance), so
  // the push can't step us up onto something taller behind the ledge. The controller is
  // shared by every player, so set it explicitly each tick.
  if (mantleTicks > 0) ctx.controller.disableAutostep();
  else ctx.controller.enableAutostep(t.stepHeight, t.capsuleRadius * 0.5, false);
  const desired = ctx.scratch.desired;
  desired.x = vx * dt;
  desired.y = dy;
  desired.z = vz * dt;
  ctx.controller.computeColliderMovement(
    body.collider,
    desired,
    ctx.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
  );
  const moved = ctx.controller.computedMovement();
  // Never grounded while still rising: brushing a ledge's top edge mid-jump must not end the jump.
  const grounded = ctx.controller.computedGrounded() && vy <= 0;

  // Keep our velocity, but remove the part that pushes into walls (so we slide along them).
  // Floors, ceilings and low steps that autostep climbs do not slow us down.
  [vx, vz] = clipAgainstWalls(vx, vz, prev.position[1], grounded, ctx);
  if (grounded && vy < 0) vy = 0;
  if (desired.y > 0 && moved.y < desired.y * 0.5) vy = 0; // bumped a ceiling

  return {
    position: [
      f(prev.position[0] + moved.x),
      f(prev.position[1] + moved.y),
      f(prev.position[2] + moved.z),
    ],
    velocity: [f(vx), f(vy), f(vz)],
    yaw: input.yaw,
    pitch: input.pitch,
    grounded,
    crouching,
    prone,
    slideTicks,
    slideCooldownTicks,
    mantleTicks,
    mantleYaw,
    tacSprintTicks,
    tacCooldownTicks,
    sprintTapTicks,
    prevButtons: held,
  };
}

function clipAgainstWalls(
  vx: number,
  vz: number,
  feetY: number,
  grounded: boolean,
  ctx: MovementContext,
): [number, number] {
  const stepHeight = ctx.tuning.stepHeight;
  const hit = ctx.scratch.collision;
  const count = ctx.controller.numComputedCollisions();
  for (let i = 0; i < count; i++) {
    if (!ctx.controller.computedCollision(i, hit)) continue;
    const n = hit.normal1;
    if (n.y >= ctx.walkableNormalY || n.y < -0.3) continue; // floor or ceiling
    if (grounded && hit.witness1.y - feetY <= stepHeight + 0.01) continue; // a step autostep climbs
    const len = Math.sqrt(n.x * n.x + n.z * n.z);
    if (len === 0) continue;
    const nx = n.x / len;
    const nz = n.z / len;
    const into = vx * nx + vz * nz;
    if (into < 0) {
      vx -= into * nx;
      vz -= into * nz;
    }
  }
  return [vx, vz];
}

/** Move (vx, vz) towards (tx, tz) by at most rate·dt. */
function approach(
  vx: number,
  vz: number,
  tx: number,
  tz: number,
  rate: number,
  dt: number,
): [number, number] {
  const dx = tx - vx;
  const dz = tz - vz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const maxStep = rate * dt;
  if (dist <= maxStep) return [tx, tz];
  const k = maxStep / dist;
  return [vx + dx * k, vz + dz * k];
}

function placeCollider(feet: Vec3, height: number, ctx: MovementContext, body: PlayerBody): void {
  const r = ctx.tuning.capsuleRadius;
  body.collider.setHalfHeight(height / 2 - r);
  body.collider.setTranslation({ x: feet[0], y: feet[1] + SKIN + height / 2, z: feet[2] });
}

function hasHeadroom(feet: Vec3, ctx: MovementContext, body: PlayerBody): boolean {
  return hasRoom(feet, ctx, body, ctx.scratch.standingCapsule, ctx.tuning.standingHeight);
}

/** Whether a capsule of `height` fits with its feet at `feet` (ignoring our own body). */
function hasRoom(
  feet: Vec3,
  ctx: MovementContext,
  body: PlayerBody,
  capsule: MovementContext['scratch']['standingCapsule'],
  height: number,
): boolean {
  const center = { x: feet[0], y: feet[1] + SKIN + height / 2, z: feet[2] };
  const hit = ctx.world.intersectionWithShape(
    center,
    IDENTITY,
    capsule,
    ctx.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    body.collider,
  );
  return hit === null;
}

/**
 * A ledge to mantle in front of the feet: its top height above the feet, or null. Looks
 * straight down at a few points ahead (nearest first) for a walkable top between
 * mantleMinHeight and mantleMaxHeight, then checks a standing capsule fits both where we are
 * (raised to the ledge) and on top of it, so we never mantle into a ceiling or a window frame.
 */
function findLedge(feet: Vec3, sinY: number, cosY: number, ctx: MovementContext): number | null {
  const t = ctx.tuning;
  const top = feet[1] + t.mantleMaxHeight + 0.05;
  const range = t.mantleMaxHeight + 0.05 - t.mantleMinHeight;
  for (const probe of LEDGE_PROBES) {
    const d = t.capsuleRadius + probe;
    const x = feet[0] - sinY * d;
    const z = feet[2] - cosY * d;
    const ray = ctx.scratch.ray;
    ray.origin.x = x;
    ray.origin.y = top;
    ray.origin.z = z;
    const hit = ctx.world.castRayAndGetNormal(
      ray,
      range,
      true,
      ctx.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    if (!hit) continue; // nothing this high here: look further ahead
    // Starting inside something: a wall taller than we can mantle is in the way.
    if (hit.timeOfImpact <= 0.001) return null;
    if (hit.normal.y < ctx.walkableNormalY) continue;
    const ledgeY = top - hit.timeOfImpact;
    if (ledgeY - feet[1] > t.mantleMaxHeight) return null; // just too tall
    const standY = ledgeY + SKIN + 0.05 + t.standingHeight / 2;
    if (!capsuleFree(feet[0], standY, feet[2], ctx) || !capsuleFree(x, standY, z, ctx)) return null;
    return ledgeY - feet[1];
  }
  return null;
}

function capsuleFree(x: number, y: number, z: number, ctx: MovementContext): boolean {
  return (
    ctx.world.intersectionWithShape(
      { x, y, z },
      IDENTITY,
      ctx.scratch.standingCapsule,
      ctx.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    ) === null
  );
}
