import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { camoTexture } from './camo.ts';

/**
 * Dresses the base body models as faction soldiers (the models come undressed):
 *
 * - The body mesh is split by which bone moves each vertex: head = skin (the model's own
 *   texture), hands = gloves, feet and lower shins = boots, the rest = combat suit in the
 *   faction's camo, with a team-coloured band round each upper arm.
 * - Gear (helmet with headset, plate carrier with pouches and radio, belt, knee pads) is built
 *   from simple shapes fitted to the measured body, merged into one mesh per bone it rides on.
 *
 * Everything is prepared once per body variant and team and shared by every soldier; only the
 * materials that flash on a hit are per soldier.
 */

export const TEAM_COLORS = [0x2f7bff, 0xff7a1f];

interface FactionLook {
  helmet: number;
  gear: number;
  pouch: number;
  gloves: number;
  boots: number;
  /** Ember wear face masks; Aegis wear goggles up on the helmet. */
  mask: boolean;
}

const LOOKS: FactionLook[] = [
  {
    helmet: 0x2e3642,
    gear: 0x39424f,
    pouch: 0x2c333d,
    gloves: 0x23262b,
    boots: 0x1d2025,
    mask: false,
  },
  {
    helmet: 0x8a7352,
    gear: 0x6f5b40,
    pouch: 0x5c4a33,
    gloves: 0x3a3128,
    boots: 0x3b2f24,
    mask: true,
  },
];

/** Horizontal extent of the body in one height band (rest pose, metres). */
interface Band {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface BodyShape {
  chest: Band;
  waist: Band;
  head: Band & { top: number };
  kneeR: Band;
  kneeL: Band;
}

type Region = 'skin' | 'suit' | 'glove' | 'boot' | 'band';

export interface DressedParts {
  /** Body geometry with vertex colours and two groups: 0 = skin, 1 = clothing. */
  bodyGeometry: THREE.BufferGeometry;
  /** Gear geometry per bone name, already in that bone's local space. */
  gear: Map<string, THREE.BufferGeometry>;
}

const v = new THREE.Vector3();

/** The skinned body mesh of a loaded character (not the eyes or eyebrows). */
export function bodyMeshOf(root: THREE.Object3D): THREE.SkinnedMesh {
  const meshes = root.getObjectsByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh[];
  return meshes.reduce((a, b) =>
    b.geometry.attributes.position!.count > a.geometry.attributes.position!.count ? b : a,
  );
}

/** Rest-pose vertex positions in model space (the template must not be animated yet). */
function restPositions(body: THREE.SkinnedMesh): Float32Array {
  body.updateMatrixWorld(true);
  const n = body.geometry.attributes.position!.count;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    body.getVertexPosition(i, v);
    v.applyMatrix4(body.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

function band(p: Float32Array, y0: number, y1: number, keep: (x: number) => boolean): Band {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    if (y < y0 || y > y1 || !keep(x)) continue;
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minZ = Math.min(b.minZ, z);
    b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
}

export function measureBody(body: THREE.SkinnedMesh): BodyShape {
  const p = restPositions(body);
  let top = 0;
  for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]!);
  return {
    // The rest pose is a T-pose: the arms are above these bands except at the shoulders,
    // so the chest is measured inside |x| < 0.3.
    chest: band(p, 1.25, 1.35, (x) => Math.abs(x) < 0.3),
    waist: band(p, 0.95, 1.02, (x) => Math.abs(x) < 0.3),
    head: { ...band(p, 1.62, 1.72, (x) => Math.abs(x) < 0.2), top },
    kneeR: band(p, 0.5, 0.56, (x) => x < -0.02),
    kneeL: band(p, 0.5, 0.56, (x) => x > 0.02),
  };
}

/** Which part of the outfit each vertex belongs to, from its strongest bone and height. */
function regions(body: THREE.SkinnedMesh, rest: Float32Array): Region[] {
  const bones = body.skeleton.bones;
  const idx = body.geometry.attributes.skinIndex!;
  const w = body.geometry.attributes.skinWeight!;
  const shoulderX = (name: string) =>
    Math.abs(bones.find((b) => b.name === name)!.getWorldPosition(v).x);
  const upperArmStart = shoulderX('upperarm_r');
  const out: Region[] = [];
  for (let i = 0; i < idx.count; i++) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (w.getComponent(i, k) > w.getComponent(i, best)) best = k;
    const name = bones[idx.getComponent(i, best)]!.name;
    const x = rest[i * 3]!;
    const y = rest[i * 3 + 1]!;
    let r: Region = 'suit';
    if (name === 'Head' || (name === 'neck_01' && y > 1.56)) r = 'skin';
    else if (/^(hand|index|middle|ring|pinky|thumb)/.test(name)) r = 'glove';
    else if (/^(foot|ball)/.test(name) || y < 0.3) r = 'boot';
    else if (/^upperarm/.test(name)) {
      // Team band a hand's width out from the shoulder (the arm is straight out in T-pose).
      const d = Math.abs(x) - upperArmStart;
      if (d > 0.07 && d < 0.13) r = 'band';
    }
    out.push(r);
  }
  return out;
}

function dressBody(
  body: THREE.SkinnedMesh,
  team: number,
  rest: Float32Array,
): THREE.BufferGeometry {
  const look = LOOKS[team] ?? LOOKS[0]!;
  const geo = body.geometry.clone();
  const reg = regions(body, rest);
  const colors = new Float32Array(reg.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < reg.length; i++) {
    const r = reg[i]!;
    // Suit vertices are white: the camo texture gives their colour.
    c.set(
      r === 'glove'
        ? look.gloves
        : r === 'boot'
          ? look.boots
          : r === 'band'
            ? TEAM_COLORS[team]!
            : 0xffffff,
    );
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Triangles with any non-skin corner are clothing (the collar edge stays clean).
  const index = geo.index!;
  const skin: number[] = [];
  const cloth: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const d = index.getX(t + 2);
    (reg[a] === 'skin' && reg[b] === 'skin' && reg[d] === 'skin' ? skin : cloth).push(a, b, d);
  }
  geo.setIndex([...skin, ...cloth]);
  geo.clearGroups();
  geo.addGroup(0, skin.length, 0);
  geo.addGroup(skin.length, cloth.length, 1);
  return geo;
}

/** One gear piece: a shape moved into place, painted one colour. */
function piece(
  g: THREE.BufferGeometry,
  color: number,
  at: [number, number, number],
  opts: { rot?: [number, number, number]; scale?: [number, number, number] } = {},
): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(opts.rot ?? [0, 0, 0]))),
    new THREE.Vector3(...(opts.scale ?? [1, 1, 1])),
  );
  geo.applyMatrix4(m);
  const n = geo.attributes.position!.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) c.toArray(col, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const name of Object.keys(geo.attributes))
    if (!['position', 'normal', 'color'].includes(name)) geo.deleteAttribute(name);
  return geo;
}

const box = (w: number, h: number, d: number, r = 0.01) => new RoundedBoxGeometry(w, h, d, 2, r);

function buildGear(team: number, s: BodyShape): Record<string, THREE.BufferGeometry[]> {
  const look = LOOKS[team] ?? LOOKS[0]!;
  const teamColor = TEAM_COLORS[team]!;
  const h = s.head;
  const hx = (h.maxX - h.minX) / 2;
  const hz = (h.maxZ - h.minZ) / 2;
  const hcz = (h.maxZ + h.minZ) / 2;
  const hy = h.top - 0.1; // helmet centre, about a hand below the crown

  const head: THREE.BufferGeometry[] = [
    // Shell: a hemisphere, tilted back so the brow is open and the neck is covered.
    piece(
      new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      look.helmet,
      [0, hy, hcz - 0.005],
      { rot: [-0.32, 0, 0], scale: [hx + 0.035, 0.135, hz + 0.035] },
    ),
    // Team band round the shell.
    piece(new THREE.TorusGeometry(1, 0.08, 6, 28), teamColor, [0, hy + 0.035, hcz - 0.01], {
      rot: [Math.PI / 2 - 0.32, 0, 0],
      scale: [hx + 0.028, hz + 0.028, 0.12],
    }),
    // Headset ear cups (the Relay is a radio war).
    ...[-1, 1].map((sx) =>
      piece(
        new THREE.CylinderGeometry(0.038, 0.038, 0.03, 14),
        look.pouch,
        [sx * (hx + 0.012), hy - 0.05, hcz - 0.01],
        { rot: [0, 0, Math.PI / 2] },
      ),
    ),
    // Mount plate on the front of the helmet.
    piece(box(0.05, 0.035, 0.02, 0.006), look.pouch, [0, hy + 0.07, h.maxZ + 0.02], {
      rot: [-0.5, 0, 0],
    }),
  ];
  if (look.mask) {
    // Face wrap over nose and mouth.
    head.push(
      piece(
        new THREE.CylinderGeometry(1, 0.95, 0.075, 18, 1, true, -1.35, 2.7),
        look.gear,
        [0, 1.638, hcz - 0.005],
        { scale: [hx + 0.012, 1, hz + 0.018] },
      ),
    );
  } else {
    // Goggles pushed up on the helmet: strap-coloured frame, tinted lenses.
    head.push(
      piece(box(0.15, 0.04, 0.035, 0.012), look.pouch, [0, hy + 0.02, h.maxZ + 0.028], {
        rot: [-0.25, 0, 0],
      }),
      ...[-1, 1].map((sx) =>
        piece(box(0.055, 0.028, 0.012, 0.008), 0x2a5a8a, [sx * 0.034, hy + 0.02, h.maxZ + 0.047], {
          rot: [-0.25, 0, 0],
        }),
      ),
    );
  }

  // Plate carrier round the chest.
  const c = s.chest;
  const cw = (c.maxX - c.minX) / 2;
  const front = c.maxZ;
  const back = c.minZ;
  const mid = (front + back) / 2;
  const depth = front - back;
  const chest: THREE.BufferGeometry[] = [
    piece(box(cw * 1.55, 0.3, 0.05, 0.015), look.gear, [0, 1.27, front + 0.02]),
    piece(box(cw * 1.6, 0.33, 0.05, 0.015), look.gear, [0, 1.28, back - 0.02]),
    ...[-1, 1].flatMap((sx) => [
      // Side panels joining the plates.
      piece(box(0.045, 0.17, depth + 0.02, 0.01), look.gear, [sx * cw * 0.86, 1.2, mid]),
      // Shoulder straps.
      piece(box(0.065, 0.028, depth + 0.1, 0.01), look.gear, [sx * 0.105, 1.455, mid], {
        rot: [0, 0, sx * -0.12],
      }),
    ]),
    // Magazine pouches, radio pouch, team patch.
    ...[-0.085, 0, 0.085].map((x) =>
      piece(box(0.07, 0.1, 0.04, 0.01), look.pouch, [x, 1.19, front + 0.06]),
    ),
    piece(box(0.07, 0.09, 0.035, 0.01), look.pouch, [0.1, 1.34, front + 0.055]),
    piece(box(0.075, 0.045, 0.008, 0.004), teamColor, [-0.08, 1.37, front + 0.048]),
    // Radio pack and antenna on the back.
    piece(box(0.2, 0.22, 0.08, 0.02), look.pouch, [0, 1.26, back - 0.08]),
    piece(new THREE.CylinderGeometry(0.005, 0.007, 0.36, 6), 0x1a1a1a, [0.07, 1.5, back - 0.09]),
    piece(box(0.085, 0.04, 0.008, 0.004), teamColor, [0, 1.36, back - 0.121]),
  ];

  // Belt with hip pouches.
  const w = s.waist;
  const ww = (w.maxX - w.minX) / 2;
  const wd = (w.maxZ - w.minZ) / 2;
  const wmid = (w.maxZ + w.minZ) / 2;
  const hips: THREE.BufferGeometry[] = [
    piece(new THREE.CylinderGeometry(1, 1, 0.05, 24, 1, true), look.pouch, [0, 0.985, wmid], {
      scale: [ww + 0.012, 1, wd + 0.012],
    }),
    ...[-1, 1].map((sx) =>
      piece(box(0.06, 0.09, 0.08, 0.01), look.pouch, [sx * (ww + 0.02), 0.96, wmid - 0.02]),
    ),
    piece(box(0.12, 0.08, 0.045, 0.01), look.pouch, [0, 0.97, w.minZ - 0.03]),
    // Front drop pouch hanging from the belt.
    piece(box(0.15, 0.12, 0.045, 0.02), look.pouch, [0, 0.92, w.maxZ + 0.02], {
      rot: [0.12, 0, 0],
    }),
  ];
  // Cargo pockets on the outside of each thigh.
  const thigh = (sx: number) => [
    piece(box(0.05, 0.15, 0.11, 0.015), look.pouch, [sx * (ww + 0.005), 0.75, wmid + 0.005]),
  ];

  const knee = (k: Band) => [
    piece(box(0.095, 0.11, 0.035, 0.015), look.pouch, [
      (k.minX + k.maxX) / 2,
      0.52,
      k.maxZ + 0.012,
    ]),
  ];

  return {
    Head: head,
    spine_03: chest,
    pelvis: hips,
    thigh_r: thigh(-1),
    thigh_l: thigh(1),
    calf_r: knee(s.kneeR),
    calf_l: knee(s.kneeL),
  };
}

/** Prepares a body variant for one team: dressed body geometry and gear per bone. */
export function dress(template: THREE.Object3D, team: number): DressedParts {
  template.updateMatrixWorld(true);
  const body = bodyMeshOf(template);
  const rest = restPositions(body);
  const shape = measureBody(body);
  const gear = new Map<string, THREE.BufferGeometry>();
  for (const [boneName, parts] of Object.entries(buildGear(team, shape))) {
    const bone = body.skeleton.bones.find((b) => b.name === boneName);
    if (!bone) continue;
    const merged = mergeGeometries(parts, false)!;
    // Built in model space (rest pose): move into the bone's own space.
    merged.applyMatrix4(bone.matrixWorld.clone().invert());
    merged.computeBoundingSphere();
    gear.set(boneName, merged);
  }
  return { bodyGeometry: dressBody(body, team, rest), gear };
}

/** Materials of one soldier (per soldier so a hit can flash just them). */
export function soldierMaterials(
  team: number,
  skin: THREE.Material,
  normalMap: THREE.Texture | null,
): { skin: THREE.Material; cloth: THREE.MeshStandardMaterial; gear: THREE.MeshStandardMaterial } {
  const cloth = new THREE.MeshStandardMaterial({
    map: camoTexture(team),
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
    normalMap,
    // Only a trace of the body's sculpt shows through the fabric.
    normalScale: new THREE.Vector2(0.12, 0.12),
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });
  const gear = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0.05,
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });
  return { skin, cloth, gear };
}
