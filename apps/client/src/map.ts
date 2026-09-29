import * as THREE from 'three/webgpu';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Material } from '@sentinel/content';
import type { Solid } from '@sentinel/shared';
import {
  abs,
  attribute,
  float,
  materialColor,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  vec3,
} from 'three/tsl';

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

/** Per-theme scale changes (metres per texture copy), e.g. cobblestones are small. */
const THEME_METRES: Partial<Record<string, Partial<Record<Material, number>>>> = {
  town: { floor: 2.6, wall: 2.4 },
};

/**
 * Colour per theme and surface, multiplied into the (mostly grey) texture: sun-bleached sand
 * concrete and blue-painted steel in the yard, rust-red and teal sheds in the depot, warm stone
 * in the town. A grey world reads as dull and makes soldiers hard to pick out; tinted
 * surfaces give each area its own colour at no cost.
 */
const THEME_TINT: Partial<Record<string, Partial<Record<Material, number>>>> = {
  yard: { wall: 0xfff1de, floor: 0xe8ddcc, platform: 0x9fc0dc, ramp: 0xe8c86a, stairs: 0xe8c86a },
  depot: { wall: 0x7fb3b8, floor: 0xf2eee8, platform: 0xe9d9bd, ramp: 0xe8c86a, stairs: 0xe8c86a },
  town: { wall: 0xffd9c2, floor: 0xf0dcc0, ramp: 0xd98a6a },
};

/** Shipping-container paint for props (the prop texture is bare grey corrugated steel). */
const CONTAINER_PAINT = [0xa8382a, 0x2c66a6, 0x2f7c48, 0xc4782c, 0xb89a2a, 0x8a3050];

export type Surfaces = Record<Material, THREE.MeshStandardNodeMaterial>;

/**
 * Weathering on top of a surface texture: dirt splashed up the bottom metre of every wall
 * and box side (the `lift` attribute: height above the solid's own base), and big soft stains
 * from world-space noise so a texture repeated across a long wall or a yard never looks
 * stamped. A colour multiplier (1 = unchanged).
 */
function weathering() {
  const side = float(1).sub(abs(normalWorld.y));
  const lift = attribute<'float'>('lift', 'float');
  const dirt = side.mul(float(1).sub(smoothstep(0, 1.1, lift))).mul(0.5);
  const grime = mix(vec3(1, 1, 1), vec3(0.52, 0.47, 0.41), dirt);
  const stains = mx_noise_float(positionWorld.mul(vec3(0.22, 0.45, 0.22)));
  return grime.mul(float(1).add(stains.mul(0.08)));
}

/** Surface themes (tools/assets/surfaces.json): a map's look, picked per map below. */
export type Theme = 'yard' | 'depot' | 'town';
const THEME_FOR_MAP: Record<string, Theme> = { 'saltline-depot': 'depot', 'alder-street': 'town' };
export const themeOf = (mapId: string): Theme => THEME_FOR_MAP[mapId] ?? 'yard';

const surfaces = new Map<Theme, Promise<Surfaces>>();

/**
 * Weathering (wall grime, stains) costs a noise lookup on every map pixel: Medium/High only.
 * Set once at start-up from the graphics preset, before any surfaces load (a preset change
 * applies after a reload, like shadows).
 */
let weatheringOn = true;
export function setWeathering(on: boolean): void {
  weatheringOn = on;
}

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
        const mat = new THREE.MeshStandardNodeMaterial({
          map,
          normalMap,
          roughnessMap,
          roughness: 1,
          metalness: SURFACE[m].metalness,
          vertexColors: true, // container paint on props; white elsewhere
        });
        if (weatheringOn) mat.colorNode = materialColor.mul(weathering());
        mat.name = `surface:${theme}:${m}`;
        mat.color.setHex(THEME_TINT[theme]?.[m] ?? 0xffffff);
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
  addLift(geo);
  return geo;
}

/** Per vertex: height above the lowest point of this piece (dirt collects at the base). */
function addLift(geo: THREE.BufferGeometry): void {
  const p = geo.attributes.position!;
  let base = Infinity;
  for (let i = 0; i < p.count; i++) base = Math.min(base, p.getY(i));
  const lift = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) lift[i] = p.getY(i) - base;
  geo.setAttribute('lift', new THREE.BufferAttribute(lift, 1));
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

/**
 * Shipping-container trim for a container-sized prop box: corner posts, top and bottom rails,
 * and a door end with a centre seam and four locking bars. Built in the box's own frame, then
 * moved with it (world space, like the box itself). Visual only; collision is the plain box.
 */
function containerTrim(solid: Extract<Solid, { shape: 'box' }>): THREE.BufferGeometry[] {
  const [hx, hy, hz] = solid.halfExtents;
  const long = hx >= hz ? 'x' : 'z';
  const L = long === 'x' ? hx : hz; // half length
  const W = long === 'x' ? hz : hx; // half width
  if (L * 2 < 2.5 || hy * 2 < 1.4) return []; // crates and spools stay plain
  const parts: THREE.BufferGeometry[] = [];
  // In a frame where the length runs along X: size and centre, then swapped if needed.
  const add = (sx: number, sy: number, sz: number, cx: number, cy: number, cz: number) => {
    const g = new THREE.BoxGeometry(...(long === 'x' ? [sx, sy, sz] : [sz, sy, sx])).toNonIndexed();
    g.translate(...((long === 'x' ? [cx, cy, cz] : [cz, cy, cx]) as [number, number, number]));
    parts.push(g);
  };
  const t = 0.07; // trim thickness
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) add(0.16, hy * 2 + 0.02, 0.16, sx * (L - 0.06), 0, sz * (W - 0.06)); // posts
  for (const sy of [-1, 1])
    for (const sz of [-1, 1]) add(L * 2, 0.12, t * 2, 0, sy * (hy - 0.05), sz * (W + t * 0.4)); // rails
  // Door end: seam and four vertical locking bars standing off the face.
  const face = L + 0.03;
  add(0.02, hy * 2 - 0.2, 0.05, face, 0, 0);
  for (const z of [-0.62, -0.38, 0.38, 0.62].map((f) => f * W * 1.6))
    add(0.05, hy * 2 - 0.3, 0.05, face + 0.02, 0, Math.max(-W + 0.1, Math.min(W - 0.1, z)));
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...solid.center),
    new THREE.Quaternion(...solid.rotation),
    new THREE.Vector3(1, 1, 1),
  );
  for (const g of parts) {
    g.applyMatrix4(m);
    for (const name of Object.keys(g.attributes))
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    addLift(g);
  }
  return parts;
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
export function buildMapMeshes(
  solids: readonly Solid[],
  real?: Surfaces | null,
  theme: string = 'yard',
): THREE.Group {
  const metres = (m: Material) => THEME_METRES[theme]?.[m] ?? SURFACE[m].metres;
  const group = new THREE.Group();
  group.name = 'map';
  const parts = new Map<Material, THREE.BufferGeometry[]>();
  solids.forEach((solid, i) => {
    const geo = solidGeometry(solid);
    worldUvs(geo, metres(solid.material));
    // Props get a container colour (stable per solid); everything else is unpainted.
    paint(
      geo,
      solid.material === 'prop' ? CONTAINER_PAINT[(i * 7) % CONTAINER_PAINT.length]! : 0xffffff,
    );
    let list = parts.get(solid.material);
    if (!list) parts.set(solid.material, (list = []));
    list.push(geo);
    if (solid.material === 'prop' && solid.shape === 'box') {
      // Trim a shade darker than the container's paint.
      const trim = new THREE.Color(
        CONTAINER_PAINT[(i * 7) % CONTAINER_PAINT.length]!,
      ).multiplyScalar(0.62);
      for (const g of containerTrim(solid)) {
        worldUvs(g, metres('prop'));
        paint(g, trim.getHex());
        list.push(g);
      }
    }
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
