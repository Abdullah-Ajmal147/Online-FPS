import * as THREE from 'three/webgpu';
import {
  clamp,
  dot,
  float,
  materialEmissive,
  mix,
  normalView,
  positionView,
  positionViewDirection,
  pow,
  step,
  uniform,
  vec3,
} from 'three/tsl';

/**
 * Friend-or-foe rim light on soldiers (the technique VALORANT describes for gameplay
 * clarity): light along a soldier's outline, red for enemies and a softer blue for allies, a
 * little stronger at a distance, so a soldier reads against any wall or sky. Added on top of
 * the material's own emissive (the hit flash still works).
 */

/** The team we play for (set when it's known or changes): decides red vs blue everywhere. */
export const viewerTeam = uniform(0);

const ENEMY = vec3(1.0, 0.16, 0.1);
const ALLY = vec3(0.25, 0.5, 1.0);

/** An emissive node with the rim light for a soldier of `team`. */
function rimEmissive(team: number) {
  const enemy = step(0.5, viewerTeam.sub(team).abs());
  const facing = clamp(dot(normalView, positionViewDirection), 0, 1);
  const edge = pow(float(1).sub(facing), 3);
  // Farther soldiers get a stronger outline (clamped): distance is where they get lost.
  const distance = positionView.z.negate();
  const far = clamp(distance.div(25), 0.7, 1.8);
  const strength = mix(float(0.35), float(1.4), enemy).mul(far);
  return materialEmissive.add(mix(ALLY, ENEMY, enemy).mul(edge).mul(strength));
}

/** A standard material for a soldier with the rim light (same options as MeshStandardMaterial). */
export function soldierMaterial(
  team: number,
  params: THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial(params);
  m.emissiveNode = rimEmissive(team);
  return m;
}
