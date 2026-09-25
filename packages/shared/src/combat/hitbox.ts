import type { Movement } from '@sentinel/content';
import { detSinCos } from '../detmath.ts';
import type { Vec3 } from '../map/solids.ts';
import { SKIN } from '../movement/context.ts';

export type HitZone = 'head' | 'torso' | 'limbs';
export const HIT_ZONES: readonly HitZone[] = ['head', 'torso', 'limbs'];

/** A vertical capsule (segment a→b with radius). A sphere is a capsule with a = b. */
interface Capsule {
  zone: HitZone;
  a: Vec3;
  b: Vec3;
  r: number;
}

/**
 * Hitboxes of a player standing (or crouching) with feet at `feet`, as fractions of the
 * capsule height so crouching shrinks them. Head is a sphere, torso and legs are capsules.
 * Arms are not modelled separately: shots at the sides of the torso capsule count as torso.
 */
export function hitboxes(feet: Vec3, crouching: boolean, tuning: Movement): Capsule[] {
  const h = crouching ? tuning.crouchHeight : tuning.standingHeight;
  const [x, y0, z] = feet;
  const y = y0 + SKIN;
  const at = (frac: number): Vec3 => [x, y + h * frac, z];
  const head = at(0.9);
  return [
    { zone: 'head', a: head, b: head, r: 0.14 },
    // Torso top (0.70·h + r) stays below the head sphere's bottom (0.9·h − 0.14), so headshots
    // are never stolen by the torso capsule's rounded top.
    { zone: 'torso', a: at(0.52), b: at(0.7), r: 0.24 },
    { zone: 'limbs', a: at(0.1), b: at(0.47), r: 0.19 },
  ];
}

/** Distance along a unit ray to the first hit on a capsule, or null. */
export function rayCapsule(origin: Vec3, dir: Vec3, c: Capsule, maxDist: number): number | null {
  // Closest approach between the ray and the capsule's segment, then a sphere test there.
  const ab: Vec3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const ao: Vec3 = [origin[0] - c.a[0], origin[1] - c.a[1], origin[2] - c.a[2]];
  const abab = dot(ab, ab);
  if (abab < 1e-12) return raySphere(origin, dir, c.a, c.r, maxDist);
  // Infinite cylinder around the segment axis.
  const abd = dot(ab, dir);
  const abao = dot(ab, ao);
  const a = abab - abd * abd;
  const b = abab * dot(ao, dir) - abao * abd;
  const cc = abab * dot(ao, ao) - abao * abao - c.r * c.r * abab;
  let best: number | null = null;
  if (a > 1e-12) {
    const disc = b * b - a * cc;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const s = abao + t * abd; // position along the segment, 0..abab
      if (t >= 0 && t <= maxDist && s >= 0 && s <= abab) best = t;
    }
  }
  // End caps.
  for (const end of [c.a, c.b]) {
    const t = raySphere(origin, dir, end, c.r, maxDist);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

function raySphere(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  r: number,
  maxDist: number,
): number | null {
  const oc: Vec3 = [origin[0] - center[0], origin[1] - center[1], origin[2] - center[2]];
  const b = dot(oc, dir);
  const c = dot(oc, oc) - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxDist ? t : null;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Closest hitbox a ray hits, or null. */
export function rayPlayer(
  origin: Vec3,
  dir: Vec3,
  feet: Vec3,
  crouching: boolean,
  tuning: Movement,
  maxDist: number,
): { zone: HitZone; distance: number } | null {
  let best: { zone: HitZone; distance: number } | null = null;
  for (const box of hitboxes(feet, crouching, tuning)) {
    const t = rayCapsule(origin, dir, box, maxDist);
    if (t !== null && (best === null || t < best.distance)) best = { zone: box.zone, distance: t };
  }
  return best;
}

/** Unit direction from 16-bit yaw/pitch (yaw 0 faces -Z; positive pitch looks up). */
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  const [sy, cy] = detSinCos(yaw);
  const [sp, cp] = detSinCos(pitch & 0xffff);
  return [-sy * cp, sp, -cy * cp];
}

/**
 * Damage after range falloff: full up to `start`, linear down to `minMultiplier` at `end`.
 * Rounded to whole HP.
 */
export function damageAt(
  base: number,
  distance: number,
  falloff: { start: number; end: number; minMultiplier: number },
): number {
  if (distance <= falloff.start) return base;
  const t = Math.min(1, (distance - falloff.start) / (falloff.end - falloff.start));
  return Math.max(1, Math.round(base * (1 - t * (1 - falloff.minMultiplier))));
}
