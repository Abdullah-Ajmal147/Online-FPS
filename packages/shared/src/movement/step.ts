import { TICK_DT } from '../constants.ts';
import { detSinCos } from '../detmath.ts';
import { Button, sanitizeInput, type PlayerInput } from '../input.ts';
import type { Vec3 } from '../map/solids.ts';
import { SKIN, capsuleHeight, type MovementContext, type PlayerBody } from './context.ts';
import type { PlayerState } from './state.ts';

const f = Math.fround;
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
  let slideTicks = prev.slideTicks;
  let slideCooldownTicks = Math.max(0, prev.slideCooldownTicks - 1);
  const hSpeed = Math.sqrt(vx * vx + vz * vz);
  const sprintHeld = (held & Button.Sprint) !== 0 && fwd > 0;

  // --- Crouch / stand. Standing up needs head room. Releasing crouch ends a slide. ---
  if (held & Button.Crouch) {
    crouching = true;
  } else {
    slideTicks = 0;
    if (crouching && hasHeadroom(prev.position, ctx, body)) crouching = false;
  }

  // --- Slide: press crouch while grounded and sprinting forward at sprint pace. ---
  // Needs Sprint + Forward held and no cooldown, so tapping crouch cannot chain slides.
  if (
    prev.grounded &&
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
  let jumped = false;
  if (prev.grounded && pressed & Button.Jump) {
    vy = Math.sqrt(2 * t.gravity * t.jumpHeight);
    jumped = true;
    slideTicks = 0;
  }

  // --- Horizontal velocity. ---
  // A jump tick still uses ground rules, so chained hops are pulled back to normal speed.
  // Only a jump straight out of a slide keeps the slide's speed (for that one hop).
  const groundRules = prev.grounded && !(jumped && wasSliding);
  if (slideTicks > 0 && prev.grounded && !jumped) {
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
    const sprinting = sprintHeld && !crouching;
    let target = crouching ? t.crouchSpeed : sprinting ? t.sprintSpeed : t.walkSpeed;
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
  const height = capsuleHeight(t, crouching);
  placeCollider(prev.position, height, ctx, body);
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
    slideTicks,
    slideCooldownTicks,
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
  const center = { x: feet[0], y: feet[1] + SKIN + ctx.tuning.standingHeight / 2, z: feet[2] };
  const hit = ctx.world.intersectionWithShape(
    center,
    IDENTITY,
    ctx.scratch.standingCapsule,
    ctx.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    body.collider,
  );
  return hit === null;
}
