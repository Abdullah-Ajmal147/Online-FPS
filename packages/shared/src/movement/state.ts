import type { Vec3 } from '../map/solids.ts';

/**
 * Everything the movement simulation needs to continue from one tick to the next.
 * Every field is sent to the owning player in snapshots so reconciliation can resume
 * from exactly the server's state (ADR 0003). Numbers are float32-exact.
 */
export interface PlayerState {
  /** Feet position (bottom of the capsule), metres. */
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  /** Lying down (prone). Never together with crouching. */
  prone: boolean;
  /** Ticks left in the current slide; 0 = not sliding. */
  slideTicks: number;
  /** Ticks until another slide may start; 0 = allowed. */
  slideCooldownTicks: number;
  /** Ticks left of the current mantle (climb over a ledge); 0 = not mantling. */
  mantleTicks: number;
  /** Direction the current mantle pushes (16-bit yaw, fixed when it starts). */
  mantleYaw: number;
  /** Ticks left of tactical sprint; 0 = not tactical sprinting. */
  tacSprintTicks: number;
  /** Ticks until tactical sprint may start again. */
  tacCooldownTicks: number;
  /** Ticks left in which a second sprint press counts as a double tap. */
  sprintTapTicks: number;
  /** Buttons of the previous tick, to detect presses (jump, slide) instead of holds. */
  prevButtons: number;
}

export function createPlayerState(position: Vec3, yaw: number): PlayerState {
  return {
    position: [Math.fround(position[0]), Math.fround(position[1]), Math.fround(position[2])],
    velocity: [0, 0, 0],
    yaw: yaw & 0xffff,
    pitch: 0,
    grounded: false,
    crouching: false,
    prone: false,
    slideTicks: 0,
    slideCooldownTicks: 0,
    mantleTicks: 0,
    mantleYaw: 0,
    tacSprintTicks: 0,
    tacCooldownTicks: 0,
    sprintTapTicks: 0,
    prevButtons: 0,
  };
}

/** Spawn yaw in degrees (map data) to the simulation's 16-bit yaw. */
export function yawFromDegrees(degrees: number): number {
  return (((Math.round((degrees / 360) * 65536) % 65536) + 65536) % 65536) & 0xffff;
}
