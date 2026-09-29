import type { Kick } from '@sentinel/content';

/** Kick channels: back (m), up (m), pitch, yaw, roll (radians). */
const N = 5;
const DEG = Math.PI / 180;

/**
 * The first-person gun's kick: five damped springs (back, up, pitch, yaw, roll) that every
 * shot gives a push. Shots in quick succession stack (a spray climbs and shudders), and the
 * gun settles back on its own, with a little overshoot when `dampingRatio` < 1. Visual only:
 * where the shot goes is the simulation's recoil, not this.
 */
export class KickSpring {
  readonly offset = new Float64Array(N);
  private readonly velocity = new Float64Array(N);
  private readonly amp = new Float64Array(N);

  /**
   * A shot. `ads` 0–1 scales toward the kick's adsScale; `side` (−1..1, random per shot)
   * picks which way yaw and roll go.
   */
  fire(kick: Kick, ads: number, side: number, rollSide: number): void {
    const scale = 1 - (1 - kick.adsScale) * ads;
    const amp = this.amp;
    amp[0] = kick.back;
    amp[1] = kick.up;
    amp[2] = kick.pitch * DEG;
    amp[3] = kick.yaw * DEG * side;
    amp[4] = kick.roll * DEG * rollSide;
    // Push each spring so that on its own it would peak at the amplitude.
    const perVelocity = peakPerVelocity(kick.frequency, kick.dampingRatio);
    for (let i = 0; i < N; i++) this.velocity[i]! += (amp[i]! * scale) / perVelocity;
  }

  /** Advance by `dt` seconds: the exact solution of each spring, so any frame rate agrees. */
  update(dt: number, kick: Kick): void {
    const t = Math.min(dt, 0.1);
    const z = Math.min(kick.dampingRatio, 0.999);
    const w = kick.frequency;
    const wd = w * Math.sqrt(1 - z * z);
    const decay = Math.exp(-z * w * t);
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    for (let i = 0; i < N; i++) {
      const x0 = this.offset[i]!;
      const v0 = this.velocity[i]!;
      // x(t) = e^(−ζωt) · (x0·cos ωd·t + (v0 + ζω·x0)/ωd · sin ωd·t), and its derivative.
      const b = (v0 + z * w * x0) / wd;
      this.offset[i] = decay * (x0 * cos + b * sin);
      this.velocity[i] = decay * ((b * wd - z * w * x0) * cos - (x0 * wd + z * w * b) * sin);
    }
  }

  reset(): void {
    this.offset.fill(0);
    this.velocity.fill(0);
  }
}

/**
 * How far a spring at rest travels, at most, per unit of starting speed: a damped spring
 * pushed from rest peaks at (v0 / ωd) · e^(−ζω·t) · sin(ωd·t) with t = atan(ωd / ζω) / ωd.
 */
export function peakPerVelocity(frequency: number, dampingRatio: number): number {
  const z = Math.min(dampingRatio, 0.999);
  const wd = frequency * Math.sqrt(1 - z * z);
  const t = Math.atan2(wd, z * frequency) / wd;
  return (Math.exp(-z * frequency * t) * Math.sin(wd * t)) / wd;
}
