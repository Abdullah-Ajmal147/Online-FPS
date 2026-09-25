import { MAX_PITCH, pitchToRadians } from '@sentinel/shared';

export interface Look {
  /** Radians, 0 = facing -Z, increasing turns left. Wrapped to [0, 2π). */
  yaw: number;
  /** Radians, positive looks up. */
  pitch: number;
}

const TWO_PI = Math.PI * 2;
const MAX_PITCH_RAD = pitchToRadians(MAX_PITCH);

/**
 * Apply raw mouse movement. Sensitivity is degrees per mouse count, so the same number
 * feels the same at any frame rate. Moving the mouse right turns right (yaw decreases);
 * moving it down looks down.
 */
export function applyLook(look: Look, dx: number, dy: number, degreesPerCount: number): Look {
  const k = (degreesPerCount * Math.PI) / 180;
  let yaw = (look.yaw - dx * k) % TWO_PI;
  if (yaw < 0) yaw += TWO_PI;
  const pitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, look.pitch - dy * k));
  return { yaw, pitch };
}
