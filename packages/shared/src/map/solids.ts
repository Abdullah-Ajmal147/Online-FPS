import type { GameMap, Material, Primitive } from '@sentinel/content';

export type Vec3 = readonly [number, number, number];
/** Quaternion as [x, y, z, w]. */
export type Quat = readonly [number, number, number, number];
type QuarterYaw = 0 | 90 | 180 | 270;

/**
 * The map after expanding primitives. Both the physics world (Rapier) and the renderer
 * (Three.js) are built from this list, so what you see is exactly what you collide with.
 */
export type Solid =
  | { shape: 'box'; center: Vec3; halfExtents: Vec3; rotation: Quat; material: Material }
  | { shape: 'hull'; points: readonly Vec3[]; material: Material };

/**
 * Rotate a point around +Y by a quarter turn. Exact: only swaps and sign flips, no trig.
 * Convention: yaw 0 faces -Z, positive yaw turns left (towards -X), like Three.js.
 */
export function rotateYawQuarter([x, y, z]: Vec3, yawDeg: QuarterYaw): Vec3 {
  // `+ 0` turns -0 into 0 so results serialize and compare identically everywhere.
  switch (yawDeg) {
    case 0:
      return [x + 0, y + 0, z + 0];
    case 90:
      return [z + 0, y + 0, -x + 0];
    case 180:
      return [-x + 0, y + 0, -z + 0];
    case 270:
      return [-z + 0, y + 0, x + 0];
  }
}

/** Exact quaternion for a quarter-turn yaw (Math.SQRT1_2 is a spec constant, same everywhere). */
export function quarterYawQuat(yawDeg: QuarterYaw): Quat {
  switch (yawDeg) {
    case 0:
      return [0, 0, 0, 1];
    case 90:
      return [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    case 180:
      return [0, 1, 0, 0];
    case 270:
      return [0, Math.SQRT1_2, 0, -Math.SQRT1_2];
  }
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function expandPrimitive(p: Primitive): Solid[] {
  switch (p.kind) {
    case 'box':
      return [
        {
          shape: 'box',
          center: p.center,
          halfExtents: [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2],
          rotation: quarterYawQuat(p.yawDeg),
          material: p.material,
        },
      ];

    case 'ramp': {
      // Solid wedge climbing along local -Z (forward). Solid, so nobody gets stuck underneath.
      const w = p.width / 2;
      const local: Vec3[] = [
        [-w, 0, 0],
        [w, 0, 0],
        [-w, 0, -p.run],
        [w, 0, -p.run],
        [-w, p.rise, -p.run],
        [w, p.rise, -p.run],
      ];
      return [
        {
          shape: 'hull',
          points: local.map((pt) => add(p.base, rotateYawQuarter(pt, p.yawDeg))),
          material: p.material,
        },
      ];
    }

    case 'stairs': {
      // Each step is a solid box from the ground up, so the staircase has no gaps below.
      const solids: Solid[] = [];
      for (let i = 0; i < p.steps; i++) {
        const height = (i + 1) * p.stepRise;
        const localCenter: Vec3 = [0, height / 2, -(i * p.stepDepth + p.stepDepth / 2)];
        solids.push({
          shape: 'box',
          center: add(p.start, rotateYawQuarter(localCenter, p.yawDeg)),
          halfExtents: [p.width / 2, height / 2, p.stepDepth / 2],
          rotation: quarterYawQuat(p.yawDeg),
          material: p.material,
        });
      }
      return solids;
    }
  }
}

export function expandMap(map: GameMap): Solid[] {
  return map.geometry.flatMap(expandPrimitive);
}
