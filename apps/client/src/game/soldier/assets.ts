import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { bodyMeshOf, dress, soldierMaterials, type DressedParts } from './outfit.ts';

/**
 * Character assets (see tools/assets): two body variants, one animation set for both (same
 * skeleton), weapon models. Loaded once, in the background: soldiers are drawn as the simple
 * built-in shapes until this resolves, so joining a match never waits for it.
 */
export interface SoldierAssets {
  bodies: GLTF[];
  clips: Map<string, THREE.AnimationClip>;
  weapons: Map<string, THREE.Object3D>;
}

const BASE = `${import.meta.env.BASE_URL}assets/`;
const BODY_FILES = ['characters/soldier-m.glb', 'characters/soldier-f.glb'];
export const WEAPON_MODEL_IDS = ['rifle', 'smg', 'shotgun', 'marksman', 'sidearm'] as const;

let loading: Promise<SoldierAssets> | null = null;

export function loadSoldierAssets(): Promise<SoldierAssets> {
  // Browser tests (dev builds under automation) draw the simple soldiers unless a test asks for
  // the models: CI machines render in software on two cores, where eleven animated models slow
  // the page so much that timing-based gameplay checks fail. The models have their own tests.
  const w = window as { __sentinelSimpleSoldiers?: boolean; __sentinelSoldierModels?: boolean };
  if (
    import.meta.env.DEV &&
    (w.__sentinelSimpleSoldiers || (navigator.webdriver && !w.__sentinelSoldierModels))
  )
    return Promise.reject(new Error('simple soldiers (automated test)'));
  loading ??= (async () => {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const get = (f: string) => loader.loadAsync(BASE + f);
    const [bodies, anims, weapons] = await Promise.all([
      Promise.all(BODY_FILES.map(get)),
      get('characters/animations.glb'),
      Promise.all(
        WEAPON_MODEL_IDS.map((id) =>
          get(`weapons/${id}.glb`)
            .then((g) => [id, g.scene] as const)
            .catch(() => null),
        ),
      ),
    ]);
    return {
      bodies,
      clips: new Map(anims.animations.map((c) => [c.name, c])),
      weapons: new Map(weapons.filter((w) => w !== null)),
    };
  })();
  return loading;
}

const dressed = new Map<string, DressedParts>();

export interface SoldierModel {
  root: THREE.Object3D;
  body: THREE.SkinnedMesh;
  bones: Map<string, THREE.Bone>;
  /** Materials that flash white on a confirmed hit. */
  flashMats: THREE.MeshStandardMaterial[];
}

/** A new dressed soldier (variant 0 = male body, 1 = female body). */
export function createSoldierModel(
  assets: SoldierAssets,
  team: number,
  variant: number,
): SoldierModel {
  const gltf = assets.bodies[variant % assets.bodies.length]!;
  const key = `${variant}:${team}`;
  let parts = dressed.get(key);
  if (!parts) {
    parts = dress(gltf.scene, team);
    dressed.set(key, parts);
  }
  const root = cloneSkinned(gltf.scene);
  const body = bodyMeshOf(root);
  const original = body.material as THREE.MeshStandardMaterial;
  const mats = soldierMaterials(team, original, original.normalMap);
  body.geometry = parts.bodyGeometry;
  body.material = [mats.skin, mats.cloth];
  const bones = new Map<string, THREE.Bone>();
  for (const b of body.skeleton.bones) bones.set(b.name, b);
  for (const [boneName, geo] of parts.gear) {
    const mesh = new THREE.Mesh(geo, mats.gear);
    mesh.name = `gear:${boneName}`;
    bones.get(boneName)?.add(mesh);
  }
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      // Skinned meshes move away from their rest bounds; don't let culling drop them.
      o.frustumCulled = false;
    }
  });
  return { root, body, bones, flashMats: [mats.cloth, mats.gear] };
}
