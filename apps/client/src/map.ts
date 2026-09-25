import * as THREE from 'three/webgpu';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type { Material } from '@sentinel/content';
import type { Solid } from '@sentinel/shared';

/** Greybox palette: flat colours per material so shapes read clearly. */
const COLORS: Record<Material, number> = {
  floor: 0x3a3f47,
  wall: 0x59616d,
  prop: 0xb08d57,
  ramp: 0x4f7ea8,
  stairs: 0x6b8f5e,
  platform: 0x7d6a9a,
};

/**
 * Turn the expanded map solids (the same list the physics world is built from)
 * into Three.js meshes, so the visuals match the colliders exactly.
 */
export function buildMapMeshes(solids: readonly Solid[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  const materials = new Map<Material, THREE.MeshStandardMaterial>();
  const materialFor = (m: Material) => {
    let mat = materials.get(m);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: COLORS[m], roughness: 0.85 });
      materials.set(m, mat);
    }
    return mat;
  };

  for (const solid of solids) {
    let mesh: THREE.Mesh;
    if (solid.shape === 'box') {
      const [hx, hy, hz] = solid.halfExtents;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
        materialFor(solid.material),
      );
      mesh.position.set(...solid.center);
      mesh.quaternion.set(...solid.rotation);
    } else {
      const points = solid.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      mesh = new THREE.Mesh(new ConvexGeometry(points), materialFor(solid.material));
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
