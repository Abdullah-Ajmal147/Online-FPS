import RAPIER from '@dimforge/rapier3d-compat';
import type { Solid } from './map/solids.ts';

export type Rapier = typeof RAPIER;
export type PhysicsWorld = InstanceType<Rapier['World']>;

let ready: Promise<Rapier> | undefined;

/**
 * Load Rapier's WASM once. Must be awaited before any other physics call,
 * in the browser and on the server alike.
 */
export function initPhysics(): Promise<Rapier> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/**
 * Build the static collision world for a map. Players are kinematic (moved by the
 * character controller), so the world has no gravity and is never stepped for dynamics.
 */
export function buildWorld(rapier: Rapier, solids: readonly Solid[]): PhysicsWorld {
  const world = new rapier.World({ x: 0, y: 0, z: 0 });

  for (const solid of solids) {
    let desc;
    if (solid.shape === 'box') {
      const [hx, hy, hz] = solid.halfExtents;
      const [x, y, z] = solid.center;
      const [qx, qy, qz, qw] = solid.rotation;
      desc = rapier.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(x, y, z)
        .setRotation({ x: qx, y: qy, z: qz, w: qw });
    } else {
      const hull = rapier.ColliderDesc.convexHull(new Float32Array(solid.points.flat()));
      if (!hull) throw new Error('map contains a degenerate convex hull');
      desc = hull;
    }
    world.createCollider(desc);
  }

  // Scene queries (ray casts, character controller) only see colliders after an update.
  world.step();
  return world;
}

/** Distance straight down from `from` to the first surface, or null if nothing is hit. */
export function groundHeightBelow(
  rapier: Rapier,
  world: PhysicsWorld,
  from: readonly [number, number, number],
  maxDistance = 100,
): number | null {
  const ray = new rapier.Ray({ x: from[0], y: from[1], z: from[2] }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, maxDistance, true);
  return hit ? from[1] - hit.timeOfImpact : null;
}
