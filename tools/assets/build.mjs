// Asset pipeline (Phase 5 task 1): source models in assets-src/ → small web-ready .glb files in
// apps/client/public/assets/. Run `pnpm assets` after changing a source or a setting here; the
// outputs are committed, the sources are not (see assets-src/README.md for where they come from).
//
// Every file: unused data pruned, vertex data quantized and meshopt-compressed (three.js decodes
// it with MeshoptDecoder), textures resized and re-encoded as WebP. The download-size budget is
// checked by `pnpm size` in CI.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  dedup,
  getBounds,
  meshopt,
  prune,
  resample,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'assets-src');
const OUT = join(ROOT, 'apps/client/public/assets');

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

/**
 * Reads a .gltf whose image names don't all match the files (the Universal Base Characters
 * exports reference `X_png.png` for `X.png`). Normal maps come from the OpenGL-convention folder
 * (glTF's convention); the folder next to the .gltf holds the DirectX ones for Unreal.
 */
function readGltf(file, normalsDir) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const dir = dirname(file);
  const resources = {};
  for (const b of json.buffers) resources[b.uri] = readFileSync(join(dir, b.uri));
  for (const im of json.images ?? []) {
    const name = im.uri.replace('_png.png', '.png');
    const candidates = [
      ...(/Normal/.test(name) && normalsDir ? [join(normalsDir, name)] : []),
      join(dir, im.uri),
      join(dir, name),
    ];
    const found = candidates.find(existsSync);
    if (!found) throw new Error(`${file}: image ${im.uri} not found`);
    resources[im.uri] = readFileSync(found);
  }
  return io.readJSON({ json, resources });
}

/** Keep only the vertex attributes three.js draws with (the exports carry spare UV/colour sets). */
function stripAttributes(
  doc,
  keep = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'],
) {
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      for (const sem of prim.listSemantics()) if (!keep.includes(sem)) prim.setAttribute(sem, null);
}

async function write(doc, name, { textureSize = 1024 } = {}) {
  await doc.transform(
    dedup(),
    prune(),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [textureSize, textureSize] }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true);
  const file = join(OUT, name);
  mkdirSync(dirname(file), { recursive: true });
  await io.write(file, doc);
  console.log(`${name.padEnd(28)} ${(statSync(file).size / 1024).toFixed(0).padStart(6)} KB`);
}

// ---- Soldiers: Universal Base Characters (CC0, Quaternius) ------------------------------------
const UBC = join(SRC, 'universal-base-characters/Base Characters');
const NORMALS = join(UBC, 'Textures/Normals Unity - Godot');
for (const [src, out] of [
  ['Superhero_Male_FullBody.gltf', 'characters/soldier-m.glb'],
  ['Superhero_Female_FullBody.gltf', 'characters/soldier-f.glb'],
]) {
  const doc = await readGltf(join(UBC, 'Godot - UE', src), NORMALS);
  stripAttributes(doc);
  // Constant roughness instead of a 3 MB roughness map: the body is dressed in the game anyway.
  for (const m of doc.getRoot().listMaterials()) {
    m.setMetallicRoughnessTexture(null);
    m.setRoughnessFactor(0.75);
  }
  await write(doc, out);
}

// ---- Animations: Universal Animation Library (CC0, Quaternius), same skeleton -----------------
const CLIPS = [
  'Idle_Loop',
  'Walk_Loop',
  'Jog_Fwd_Loop',
  'Sprint_Loop',
  'Crouch_Idle_Loop',
  'Crouch_Fwd_Loop',
  'Jump_Start',
  'Jump_Loop',
  'Jump_Land',
  'Death01',
  'Hit_Chest',
  'Pistol_Idle_Loop',
  'Pistol_Aim_Up',
  'Pistol_Aim_Neutral',
  'Pistol_Aim_Down',
  'Pistol_Shoot',
  'Pistol_Reload',
];
{
  const doc = await io.read(
    join(SRC, 'universal-animation-library/Unreal-Godot/UAL1_Standard.glb'),
  );
  const root = doc.getRoot();
  // Dropping a clip must drop its keyframes too (prune keeps accessors a sampler still uses),
  // except key times the clips we keep share.
  const kept = new Set();
  for (const a of root.listAnimations())
    if (CLIPS.includes(a.getName()))
      for (const smp of a.listSamplers()) kept.add(smp.getInput()).add(smp.getOutput());
  for (const a of root.listAnimations()) {
    if (CLIPS.includes(a.getName())) continue;
    for (const smp of a.listSamplers()) {
      for (const acc of [smp.getInput(), smp.getOutput()])
        if (acc && !kept.has(acc) && !acc.isDisposed()) acc.dispose();
      smp.dispose();
    }
    for (const ch of a.listChannels()) ch.dispose();
    a.dispose();
  }
  // Bones only rotate (constant lengths, no scaling); only the pelvis also moves (bob, crouch).
  for (const a of root.listAnimations())
    for (const ch of a.listChannels()) {
      const path = ch.getTargetPath();
      const bone = ch.getTargetNode()?.getName();
      if (path === 'scale' || (path === 'translation' && bone !== 'pelvis')) {
        const smp = ch.getSampler();
        ch.dispose();
        if (smp && !smp.listParents().some((p) => p.propertyType === 'AnimationChannel')) {
          smp.getOutput()?.dispose();
          smp.dispose();
        }
      }
    }
  const missing = CLIPS.filter((c) => !root.listAnimations().some((a) => a.getName() === c));
  if (missing.length) throw new Error(`animation clips not found: ${missing.join(', ')}`);
  // Only the skeleton and the clips: the preview mannequin mesh goes.
  for (const n of root.listNodes()) {
    n.setMesh(null);
    n.setSkin(null);
  }
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  await doc.transform(resample({ tolerance: 1e-4 }));
  await write(doc, 'characters/animations.glb');
}

// ---- Weapons: Quaternius guns via Poly Pizza (CC0) --------------------------------------------
// Normalized here: barrel along -Z (three.js forward), real-world length, origin at the centre of
// the bounds. Where the hand holds each gun is set in the client (weaponModels.ts).
const GUNS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guns.json'), 'utf8'),
);
for (const [id, spec] of Object.entries(GUNS)) {
  const doc = await io.read(join(SRC, 'guns', spec.source));
  stripAttributes(doc, ['POSITION', 'NORMAL', 'TEXCOORD_0']);
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const b = getBounds(scene);
  // The barrel runs along the longest horizontal axis (X in most sources, Z in some).
  const alongZ = b.max[2] - b.min[2] > b.max[0] - b.min[0];
  const len = alongZ ? b.max[2] - b.min[2] : b.max[0] - b.min[0];
  const s = spec.length / len;
  // One wrapper node: centre, scale, and turn the barrel to -Z (three.js forward). `flip` in
  // guns.json says the source's barrel points the other way.
  const wrap = doc.createNode('weapon');
  for (const n of scene.listChildren()) {
    scene.removeChild(n);
    wrap.addChild(n);
  }
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  // Barrel along +X → -Z: +90° about Y. Along -Z already: no turn. Flip adds 180°.
  const angle = (alongZ ? 0 : Math.PI / 2) + (spec.flip ? Math.PI : 0);
  const q = [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
  wrap.setRotation(q);
  wrap.setScale([s, s, s]);
  // Translation applies after rotation and scale: move the rotated, scaled centre to 0.
  const [cx, cy, cz] = c.map((x) => x * s);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  wrap.setTranslation([-(cx * cos + cz * sin), -cy, -(-cx * sin + cz * cos)]);
  scene.addChild(wrap);
  for (const m of root.listMaterials()) m.setMetallicFactor(Math.min(m.getMetallicFactor(), 0.6));
  await write(doc, `weapons/${id}.glb`);
}

// ---- Map surfaces: ambientCG textures (CC0), one set per map material ----------------------
// Colour (sRGB), normal (OpenGL convention, as glTF/three.js expect) and roughness, as WebP.
const SURFACES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'surfaces.json'), 'utf8'),
);
for (const [surface, spec] of Object.entries(SURFACES)) {
  const dir = join(SRC, 'textures', spec.source);
  const out = join(OUT, 'textures', surface);
  mkdirSync(out, { recursive: true });
  let bytes = 0;
  for (const [map, suffix, quality] of [
    ['color', 'Color', 82],
    ['normal', 'NormalGL', 90],
    ['rough', 'Roughness', 80],
  ]) {
    const file = join(out, `${map}.webp`);
    let img = sharp(join(dir, `${spec.source}_1K-JPG_${suffix}.jpg`)).resize(spec.size, spec.size);
    if (map === 'rough') img = img.greyscale();
    await img.webp({ quality }).toFile(file);
    bytes += statSync(file).size;
  }
  console.log(`${('textures/' + surface).padEnd(28)} ${(bytes / 1024).toFixed(0).padStart(6)} KB`);
}

void Document;
