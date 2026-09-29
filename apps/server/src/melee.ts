import type { Melee, Movement } from '@sentinel/content';
import { SKIN, capsuleHeight, detSinCos, directionFromAngles, type Vec3 } from '@sentinel/shared';

export interface MeleeTarget {
  id: number;
  /** Feet, as the attacker saw them (lag-compensated like a shot). */
  position: Vec3;
  crouching: boolean;
  /** Where the target faces (16-bit yaw): a strike from behind does more. */
  yaw: number;
}

/**
 * Who a melee strike from `eye` along (yaw, pitch) lands on: the nearest target whose chest
 * is within reach and within `angleDeg` of the aim, with nothing solid in between. `back`:
 * the attacker is behind them (within 60° of straight behind).
 */
export function meleeHit(
  eye: Vec3,
  yaw: number,
  pitch: number,
  targets: readonly MeleeTarget[],
  tuning: Movement,
  melee: Melee,
  clear: (from: Vec3, to: Vec3) => boolean,
): { id: number; back: boolean; distance: number } | null {
  const aim = directionFromAngles(yaw, pitch);
  const minCos = Math.cos((melee.angleDeg * Math.PI) / 180);
  let best: { id: number; back: boolean; distance: number } | null = null;
  for (const t of targets) {
    const chest: Vec3 = [
      t.position[0],
      t.position[1] + SKIN + capsuleHeight(tuning, t.crouching) * 0.6,
      t.position[2],
    ];
    const d: Vec3 = [chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]];
    const dist = Math.hypot(d[0], d[1], d[2]);
    if (dist > melee.range || dist < 1e-6) continue;
    const cos = (d[0] * aim[0] + d[1] * aim[1] + d[2] * aim[2]) / dist;
    if (cos < minCos) continue;
    if (best && dist >= best.distance) continue;
    if (!clear(eye, chest)) continue;
    // Behind: the target faces (roughly) the same way we strike.
    const [sy, cy] = detSinCos(t.yaw);
    const flat = Math.hypot(d[0], d[2]) || 1;
    const back = (-sy * d[0] - cy * d[2]) / flat > 0.5;
    best = { id: t.id, back, distance: dist };
  }
  return best;
}
