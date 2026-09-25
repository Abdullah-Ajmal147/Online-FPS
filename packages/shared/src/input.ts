import { ANGLE_STEPS } from './detmath.ts';

/** Button bits inside InputCmd (uint16). Order is part of the protocol: append only. */
export const Button = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Jump: 1 << 4,
  Crouch: 1 << 5,
  Sprint: 1 << 6,
  Fire: 1 << 7,
  Aim: 1 << 8,
  Reload: 1 << 9,
} as const;

/** Every defined button bit; anything else a client sends is ignored. */
export const KNOWN_BUTTONS = Object.values(Button).reduce((mask, bit) => mask | bit, 0);

/**
 * One tick of player input, exactly as the server receives it.
 * yaw: uint16, 65536 steps per turn, 0 = facing -Z, increasing turns left.
 * pitch: int16, ±16384 = ±90°, positive looks up. Clamped to ±MAX_PITCH.
 */
export interface PlayerInput {
  buttons: number;
  yaw: number;
  pitch: number;
  /** 0 = primary, 1 = secondary. Missing means "keep the current weapon". */
  weaponSlot?: number;
}

export const MAX_PITCH = 16000; // ≈ 87.9°, keeps the view from flipping at the poles

/**
 * Make an input safe to simulate. The server calls step() with whatever arrived over the
 * network, so step() runs this itself: unknown button bits dropped, yaw wrapped to 16 bits,
 * pitch clamped (a modified client must not aim "over the top"), non-integers truncated,
 * weapon slot limited to 0/1.
 */
export function sanitizeInput(input: PlayerInput): PlayerInput {
  const pitch = Number.isFinite(input.pitch) ? Math.trunc(input.pitch) : 0;
  const clean: PlayerInput = {
    buttons: (input.buttons | 0) & KNOWN_BUTTONS,
    yaw: (Number.isFinite(input.yaw) ? Math.trunc(input.yaw) : 0) & 0xffff,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)),
  };
  // Only slots that exist; anything else from the network is ignored (keeps the current weapon).
  if (input.weaponSlot === 0 || input.weaponSlot === 1) clean.weaponSlot = input.weaponSlot;
  return clean;
}

/** Client side only: turn a float angle in radians into the 16-bit yaw the simulation uses. */
export function yawFromRadians(radians: number): number {
  const steps = Math.round((radians / (2 * Math.PI)) * ANGLE_STEPS);
  return ((steps % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
}

export function pitchFromRadians(radians: number): number {
  const steps = Math.round((radians / (Math.PI / 2)) * 16384);
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, steps));
}

export function yawToRadians(yaw: number): number {
  return (yaw / ANGLE_STEPS) * 2 * Math.PI;
}

export function pitchToRadians(pitch: number): number {
  return (pitch / 16384) * (Math.PI / 2);
}
