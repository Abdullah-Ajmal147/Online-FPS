import type { Weapon } from '@sentinel/content';
import { TICK_RATE } from '../constants.ts';
import { ANGLE_STEPS } from '../detmath.ts';
import { Button, type PlayerInput } from '../input.ts';

/** Degrees → 16-bit angle units (65536 per turn), the unit the simulation aims in. */
export const UNITS_PER_DEGREE = ANGLE_STEPS / 360;
const toUnits = (deg: number) => Math.round(deg * UNITS_PER_DEGREE);
const toTicks = (seconds: number) => Math.max(1, Math.round(seconds * TICK_RATE));

/**
 * A weapon's data converted once, at load, to ticks and angle units. All per-tick weapon
 * logic uses only these integers, so client prediction and server agree exactly.
 */
export interface WeaponSpec {
  def: Weapon;
  fireIntervalTicks: number;
  reloadTicks: number;
  equipTicks: number;
  adsTicks: number;
  spread: {
    hip: number;
    ads: number;
    moving: number;
    airborne: number;
    perShot: number;
    max: number;
    recoveryPerTick: number;
  };
  /** Per shot [up, right] kick in angle units. */
  recoil: [number, number][];
  recoilAdsMultiplierPct: number;
  recoilRecoveryPerTick: number;
}

export function compileWeapon(def: Weapon): WeaponSpec {
  const s = def.spread;
  return {
    def,
    fireIntervalTicks: Math.max(1, Math.round((60 * TICK_RATE) / def.rpm)),
    reloadTicks: toTicks(def.reloadTime),
    equipTicks: toTicks(def.equipTime),
    adsTicks: toTicks(def.adsTime),
    spread: {
      hip: toUnits(s.hip),
      ads: toUnits(s.ads),
      moving: toUnits(s.moving),
      airborne: toUnits(s.airborne),
      perShot: toUnits(s.perShot),
      max: toUnits(s.max),
      recoveryPerTick: Math.max(1, toUnits(s.recoveryPerSecond / TICK_RATE)),
    },
    recoil: def.recoil.pattern.map(([up, right]) => [toUnits(up), toUnits(right)]),
    recoilAdsMultiplierPct: Math.round(def.recoil.adsMultiplier * 100),
    recoilRecoveryPerTick: Math.max(1, toUnits(def.recoil.recoveryPerSecond / TICK_RATE)),
  };
}

export interface WeaponAmmo {
  ammo: number;
  reserve: number;
}

/** Everything the weapon logic carries between ticks. All integers (sent exactly, ADR 0003). */
export interface WeaponState {
  slot: 0 | 1;
  ammo: [WeaponAmmo, WeaponAmmo];
  cooldownTicks: number;
  reloadTicks: number;
  switchTicks: number;
  adsTicks: number;
  /** Consecutive shots in the current burst (recoil pattern index). */
  shotIndex: number;
  /** Current recoil offset added to the view, angle units (pitch up, yaw left-positive). */
  recoilPitch: number;
  recoilYaw: number;
  /** Extra spread from recent shots, angle units. */
  bloom: number;
}

export function createWeaponState(loadout: readonly [WeaponSpec, WeaponSpec]): WeaponState {
  return {
    slot: 0,
    ammo: [
      { ammo: loadout[0].def.magazine, reserve: loadout[0].def.reserve },
      { ammo: loadout[1].def.magazine, reserve: loadout[1].def.reserve },
    ],
    cooldownTicks: 0,
    reloadTicks: 0,
    switchTicks: 0,
    adsTicks: 0,
    shotIndex: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    bloom: 0,
  };
}

export interface MoveInfo {
  moving: boolean;
  airborne: boolean;
  sprinting: boolean;
}

/** A shot the weapon fired this tick. The server resolves it into hits; the client only shows it. */
export interface ShotRequest {
  slot: 0 | 1;
  /** Aim angles for this shot in 16-bit units: view + recoil (before this shot's kick). */
  yaw: number;
  pitch: number;
  /** Spread cone radius for this shot, angle units. */
  spread: number;
}

export function adsFraction(state: WeaponState, spec: WeaponSpec): number {
  return state.adsTicks / spec.adsTicks;
}

/** Current spread cone radius in angle units (also drives the crosshair). */
export function currentSpread(state: WeaponState, spec: WeaponSpec, move: MoveInfo): number {
  const s = spec.spread;
  const base = s.hip + Math.round(((s.ads - s.hip) * state.adsTicks) / spec.adsTicks);
  return base + (move.moving ? s.moving : 0) + (move.airborne ? s.airborne : 0) + state.bloom;
}

/** Movement speed multiplier for the held weapon (slower while aiming). */
export function weaponSpeedScale(state: WeaponState, spec: WeaponSpec): number {
  const f = adsFraction(state, spec);
  const { moveSpeedMultiplier: hip, adsMoveSpeedMultiplier: ads } = spec.def;
  return hip + (ads - hip) * f;
}

const towardZero = (v: number, step: number) =>
  v > 0 ? Math.max(0, v - step) : Math.min(0, v + step);

/**
 * One tick of weapon logic. Runs on the server (authoritative: this is what stops a client
 * firing faster than the rate, without ammo, or while reloading) and in the client (prediction).
 */
export function stepWeapon(
  prev: WeaponState,
  input: PlayerInput,
  prevButtons: number,
  loadout: readonly [WeaponSpec, WeaponSpec],
  move: MoveInfo,
): { state: WeaponState; shot: ShotRequest | null } {
  const held = input.buttons;
  const pressed = held & ~prevButtons;
  const wantedSlot: 0 | 1 = input.weaponSlot === 1 ? 1 : input.weaponSlot === 0 ? 0 : prev.slot;

  let slot = prev.slot;
  const ammo: [WeaponAmmo, WeaponAmmo] = [{ ...prev.ammo[0] }, { ...prev.ammo[1] }];
  let cooldownTicks = Math.max(0, prev.cooldownTicks - 1);
  let reloadTicks = prev.reloadTicks;
  let switchTicks = Math.max(0, prev.switchTicks - 1);
  let adsTicks = prev.adsTicks;
  let shotIndex = prev.shotIndex;
  let { recoilPitch, recoilYaw, bloom } = prev;

  // --- Switch weapons (cancels a reload). ---
  if (wantedSlot !== slot) {
    slot = wantedSlot;
    switchTicks = loadout[slot].equipTicks;
    reloadTicks = 0;
    shotIndex = 0;
    adsTicks = 0;
  }
  const spec = loadout[slot];
  const mag = ammo[slot];

  // --- Reload: finishes when the timer runs out. ---
  if (reloadTicks > 0) {
    reloadTicks--;
    if (reloadTicks === 0) {
      const take = Math.min(spec.def.magazine - mag.ammo, mag.reserve);
      mag.ammo += take;
      mag.reserve -= take;
    }
  }
  const canStartReload =
    reloadTicks === 0 && switchTicks === 0 && mag.ammo < spec.def.magazine && mag.reserve > 0;
  const triedEmpty = (held & Button.Fire) !== 0 && mag.ammo === 0;
  if (canStartReload && (pressed & Button.Reload || triedEmpty)) {
    reloadTicks = spec.reloadTicks;
    shotIndex = 0;
  }

  // --- Aim down sights (not while sprinting, switching or reloading). ---
  const canAds =
    (held & Button.Aim) !== 0 && !move.sprinting && switchTicks === 0 && reloadTicks === 0;
  adsTicks = canAds ? Math.min(spec.adsTicks, adsTicks + 1) : Math.max(0, adsTicks - 1);

  // --- Fire. Auto: while held. Semi: once per press. ---
  const trigger =
    spec.def.fireMode === 'auto' ? (held & Button.Fire) !== 0 : (pressed & Button.Fire) !== 0;
  let shot: ShotRequest | null = null;
  const ready = cooldownTicks === 0 && reloadTicks === 0 && switchTicks === 0 && !move.sprinting;
  if (trigger && ready && mag.ammo > 0) {
    const nextState = { ...prev, adsTicks, bloom };
    shot = {
      slot,
      yaw: (input.yaw + recoilYaw) & 0xffff,
      pitch: Math.max(-16383, Math.min(16383, input.pitch + recoilPitch)),
      spread: Math.min(
        currentSpread(nextState, spec, move),
        spec.spread.max + spec.spread.airborne,
      ),
    };
    mag.ammo--;
    cooldownTicks = spec.fireIntervalTicks;
    const [up, right] = spec.recoil[Math.min(shotIndex, spec.recoil.length - 1)]!;
    // Aiming reduces kick: blend between 100% and the ADS multiplier by how far in we are.
    const pct = 100 + Math.round(((spec.recoilAdsMultiplierPct - 100) * adsTicks) / spec.adsTicks);
    recoilPitch += Math.round((up * pct) / 100);
    recoilYaw -= Math.round((right * pct) / 100); // right = negative yaw
    shotIndex++;
    bloom = Math.min(spec.spread.max, bloom + spec.spread.perShot);
  } else if (!trigger || mag.ammo === 0 || reloadTicks > 0 || switchTicks > 0) {
    // Stopped shooting: recoil and bloom settle back. (Not between shots of a spray —
    // otherwise recovery cancels the kick and a spray never climbs.)
    recoilPitch = towardZero(recoilPitch, spec.recoilRecoveryPerTick);
    recoilYaw = towardZero(recoilYaw, spec.recoilRecoveryPerTick);
    bloom = towardZero(bloom, spec.spread.recoveryPerTick);
    if ((held & Button.Fire) === 0) shotIndex = 0;
  }

  return {
    state: {
      slot,
      ammo,
      cooldownTicks,
      reloadTicks,
      switchTicks,
      adsTicks,
      shotIndex,
      recoilPitch,
      recoilYaw,
      bloom,
    },
    shot,
  };
}
