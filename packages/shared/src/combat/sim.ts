import type { Movement, Weapon } from '@sentinel/content';
import { Button, sanitizeInput, type PlayerInput } from '../input.ts';
import type { Vec3 } from '../map/solids.ts';
import { SKIN, capsuleHeight, type MovementContext, type PlayerBody } from '../movement/context.ts';
import type { PlayerState } from '../movement/state.ts';
import { step } from '../movement/step.ts';
import {
  compileWeapon,
  stepWeapon,
  weaponSpeedScale,
  type ShotRequest,
  type WeaponSpec,
  type WeaponState,
} from './weapon.ts';

/** Everything one player's simulation carries between ticks: movement + weapon. */
export interface SimState {
  move: PlayerState;
  weapon: WeaponState;
}

export interface SimContext {
  movement: MovementContext;
  loadout: readonly [WeaponSpec, WeaponSpec];
}

export function createSimContext(
  movement: MovementContext,
  loadout: readonly [Weapon, Weapon],
): SimContext {
  return { movement, loadout: [compileWeapon(loadout[0]), compileWeapon(loadout[1])] };
}

/**
 * Eye height above the feet. Lying down it is at the prone head's height (movement.json
 * proneEyeHeight), never above the prone hitboxes: an eye that clears low cover the body
 * can't be hit behind would let a prone player shoot over it untouchable.
 */
export function eyeHeight(tuning: Movement, crouching: boolean, prone = false): number {
  if (prone) return SKIN + tuning.proneEyeHeight;
  return SKIN + capsuleHeight(tuning, crouching) - tuning.eyeOffset;
}

/** Where the eyes are (shots start here). */
export function eyePosition(move: PlayerState, ctx: MovementContext): Vec3 {
  const t = ctx.tuning;
  const y = move.position[1] + eyeHeight(t, move.crouching, move.prone);
  return [move.position[0], y, move.position[2]];
}

/**
 * One tick for one player: movement, then weapon. The same function is the server's truth and
 * the client's prediction. Returns the shot fired this tick, if any (the server resolves hits).
 */
export function stepSim(
  prev: SimState,
  rawInput: PlayerInput,
  ctx: SimContext,
  body: PlayerBody,
): { state: SimState; shot: ShotRequest | null } {
  const input = sanitizeInput(rawInput);
  const spec = ctx.loadout[prev.weapon.slot];
  // Aiming stops sprinting.
  const aiming = (input.buttons & Button.Aim) !== 0;
  const moveInput = aiming ? { ...input, buttons: input.buttons & ~Button.Sprint } : input;
  const move = step(prev.move, moveInput, ctx.movement, body, weaponSpeedScale(prev.weapon, spec));

  const speed = Math.sqrt(
    move.velocity[0] * move.velocity[0] + move.velocity[2] * move.velocity[2],
  );
  const fwdHeld =
    (moveInput.buttons & Button.Forward) !== 0 && (moveInput.buttons & Button.Back) === 0;
  // Mantling counts as sprinting for the weapon: it is lowered while climbing over.
  const sprinting =
    move.mantleTicks > 0 ||
    ((moveInput.buttons & Button.Sprint) !== 0 &&
      fwdHeld &&
      !move.crouching &&
      speed > ctx.movement.tuning.walkSpeed);
  const { state: weapon, shot } = stepWeapon(
    prev.weapon,
    input,
    prev.move.prevButtons,
    ctx.loadout,
    {
      moving: speed > 1,
      airborne: !move.grounded,
      sprinting,
      // Lying down steadies the weapon (movement.json).
      steadyPct: move.prone
        ? {
            spread: Math.round(ctx.movement.tuning.proneSpread * 100),
            recoil: Math.round(ctx.movement.tuning.proneRecoil * 100),
          }
        : undefined,
    },
  );
  return { state: { move, weapon }, shot };
}
