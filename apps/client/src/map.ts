import * as THREE from 'three/webgpu';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Material } from '@sentinel/content';
import type { Solid } from '@sentinel/shared';

/** Flat colours per material: used until the surface textures have loaded (and in tests). */
const COLORS: Record<Material, number> = {
  floor: 0x6a6f76,
  wall: 0x8b939e,
  prop: 0xc8964f,
  ramp: 0x5a93cf,
  stairs: 0x76ab6a,
  platform: 0x9a82c8,
};

/**
 * Real surfaces (CC0 ambientCG textures, see tools/assets/surfaces.json): how many metres one
 * copy of the texture covers, and how metallic it is.
 */
const SURFACE: Record<Material, { metres: number; metalness: number }> = {
  floor: { metres: 7, metalness: 0 },
  wall: { metres: 3.5, metalness: 0 },
  prop: { metres: 2.4, metalness: 0.35 },
  ramp: { metres: 1.2, metalness: 0.45 },
  stairs: { metres: 1.2, metalness: 0.45 },
  platform: { metres: 2.5, metalness: 0.4 },
};

/** Shipping-container paint for props (the prop texture is bare grey corrugated steel). */
const CONTAINER_PAINT = [0x8c3a2c, 0x2f5a86, 0x3d6a45, 0xa4652e, 0x7c7f84, 0x6e2f45];

export type Surfaces = Record<Material, THREE.MeshStandardMaterial>;

/** Surface themes (tools/assets/surfaces.json): a map's look, picked per map below. */
export type Theme = 'yard' | 'depot';
const THEME_FOR_MAP: Record<string, Theme> = { 'saltline-depot': 'depot' };
export const themeOf = (mapId: string): Theme => THEME_FOR_MAP[mapId] ?? 'yard';

const surfaces = new Map<Theme, Promise<Surfaces>>();

/** Load a theme's surface textures once (in the background). */
export function loadSurfaces(theme: Theme = 'yard'): Promise<Surfaces> {
  let loading = surfaces.get(theme);
  if (loading) return loading;
  loading = (async () => {
    const loader = new THREE.TextureLoader();
    const base = `${import.meta.env.BASE_URL}assets/textures/${theme}/`;
    const tex = async (m: Material, name: string, srgb: boolean) => {
      const t = await loader.loadAsync(`${base}${m}/${name}.webp`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const entries = await Promise.all(
      (Object.keys(SURFACE) as Material[]).map(async (m) => {
        const [map, normalMap, roughnessMap] = await Promise.all([
          tex(m, 'color', true),
          tex(m, 'normal', false),
          tex(m, 'rough', false),
        ]);
        const mat = new THREE.MeshStandardMaterial({
          map,
          normalMap,
          roughnessMap,
          roughness: 1,
          metalness: SURFACE[m].metalness,
          vertexColors: true, // container paint on props; white elsewhere
        });
        mat.name = `surface:${theme}:${m}`;
        return [m, mat] as const;
      }),
    );
    return Object.fromEntries(entries) as Surfaces;
  })();
  surfaces.set(theme, loading);
  return loading;
}

/** Geometry of one solid in world space, with just position, normal, uv and colour. */
function solidGeometry(solid: Solid): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry;
  if (solid.shape === 'box') {
    const [hx, hy, hz] = solid.halfExtents;
    geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2).toNonIndexed();
    geo.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...solid.center),
        new THREE.Quaternion(...solid.rotation),
        new THREE.Vector3(1, 1, 1),
      ),
    );
  } else {
    geo = new ConvexGeometry(solid.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  }
  for (const name of Object.keys(geo.attributes))
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  return geo;
}

/**
 * Texture coordinates from world position, projected along each face's main axis: every surface
 * tiles at real scale and lines up across neighbouring boxes (no stretched textures).
 */
function worldUvs(geo: THREE.BufferGeometry, metres: number): void {
  const p = geo.attributes.position!;
  const n = geo.attributes.normal!;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    const [u, v] =
      ay >= ax && ay >= az
        ? [p.getX(i), p.getZ(i)]
        : ax >= az
          ? [p.getZ(i), p.getY(i)]
          : [p.getX(i), p.getY(i)];
    uv[i * 2] = u / metres;
    uv[i * 2 + 1] = v / metres;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function paint(geo: THREE.BufferGeometry, color: number): void {
  const c = new THREE.Color(color);
  const count = geo.attributes.position!.count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) c.toArray(col, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * Turn the expanded map solids (the same list the physics world is built from) into meshes,
 * so the visuals match the colliders exactly. One merged mesh per material (a handful of draw
 * calls for the whole map). With `surfaces`, real textured materials; without, flat colours.
 */
export function buildMapMeshes(solids: readonly Solid[], real?: Surfaces | null): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  const parts = new Map<Material, THREE.BufferGeometry[]>();
  solids.forEach((solid, i) => {
    const geo = solidGeometry(solid);
    worldUvs(geo, SURFACE[solid.material].metres);
    // Props get a container colour (stable per solid); everything else is unpainted.
    paint(
      geo,
      solid.material === 'prop' ? CONTAINER_PAINT[(i * 7) % CONTAINER_PAINT.length]! : 0xffffff,
    );
    let list = parts.get(solid.material);
    if (!list) parts.set(solid.material, (list = []));
    list.push(geo);
  });
  for (const [material, geos] of parts) {
    const merged = mergeGeometries(geos, false)!;
    for (const g of geos) g.dispose();
    const mat =
      real?.[material] ??
      new THREE.MeshStandardMaterial({
        color: COLORS[material],
        roughness: 0.85,
        vertexColors: material === 'prop',
      });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `map:${material}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
