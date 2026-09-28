import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { WEAPON_MODEL_IDS } from './holds.ts';
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

let loading: Promise<SoldierAssets> | null = null;

export function loadSoldierAssets(): Promise<SoldierAssets> {
  // Browser tests (dev builds under automation) draw the simple soldiers unless a test asks for
  // the models: CI machines render in software on two cores, where eleven animated models slow
  // the page so much that timing-based gameplay checks fail. The models have their own tests.
  const w = window as { __sentinelSimpleSoldiers?: boolean; __sentinelSoldierModels?: boolean };
  if (
    import.meta.env.DEV &&
    (w.__sentinelSimpleSoldiers ||
      (navigator.webdriver &&
        !w.__sentinelSoldierModels &&
        !new URLSearchParams(location.search).has('models')))
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
            .then((g) => [id, finishGun(g.scene)] as const)
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

/**
 * The weapon packs ship near-black flat materials (base colour ~0.02, no textures), which
 * read as silhouettes. Give each part a real finish by its material name: gun metal that
 * catches the sun and reflects the sky, warmer rough wood, matte polymer for the rest.
 * Shared by every copy of the model (first person and on soldiers).
 */
function finishGun(root: THREE.Object3D): THREE.Object3D {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const mat = m as THREE.MeshStandardMaterial;
      if (!mat.isMeshStandardMaterial || /glass|lens/i.test(mat.name)) continue;
      if (/wood/i.test(mat.name)) {
        mat.color.multiplyScalar(2.4);
        mat.metalness = 0;
        mat.roughness = 0.62;
      } else if (/light/i.test(mat.name)) {
        mat.color.setRGB(0.09, 0.085, 0.075); // polymer furniture
        mat.metalness = 0.05;
        mat.roughness = 0.58;
      } else {
        // Gun metal: dark but not black, polished enough for a highlight along the barrel.
        const lift = Math.max(0.055, mat.color.r * 2.2);
        mat.color.setRGB(lift, lift * 1.02, lift * 1.08);
        mat.metalness = 0.85;
        mat.roughness = /dark|black/i.test(mat.name) ? 0.42 : 0.32;
      }
      mat.needsUpdate = true;
    }
  });
  return root;
}
