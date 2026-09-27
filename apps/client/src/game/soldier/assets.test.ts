import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { weaponCatalog } from '@sentinel/content';
import { describe, expect, it } from 'vitest';
import { HOLDS, MODEL_FOR_CLASS } from './holds.ts';

/**
 * The contract between tools/assets (the pipeline) and the soldier code: every clip, bone and
 * weapon model the code asks for is in the committed files, and they stay small.
 */
const ASSETS = join(import.meta.dirname, '../../../public/assets');

/** The JSON chunk of a .glb (enough to check names without a 3D engine). */
function glbJson(file: string): {
  animations?: { name: string }[];
  nodes: { name?: string }[];
  skins?: { joints: number[] }[];
} {
  const b = readFileSync(join(ASSETS, file));
  expect(b.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

const USED_CLIPS = [
  'Idle_Loop',
  'Walk_Loop',
  'Jog_Fwd_Loop',
  'Sprint_Loop',
  'Crouch_Idle_Loop',
  'Crouch_Fwd_Loop',
  'Jump_Loop',
  'Death01',
  'Pistol_Idle_Loop',
  'Pistol_Aim_Neutral',
];
const USED_BONES = [
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'neck_01',
  'Head',
  ...['r', 'l'].flatMap((s) => [
    `clavicle_${s}`,
    `upperarm_${s}`,
    `lowerarm_${s}`,
    `hand_${s}`,
    `thigh_${s}`,
    `calf_${s}`,
  ]),
];

describe('soldier assets', () => {
  it('the animation file has every clip the rig plays', () => {
    const names = (glbJson('characters/animations.glb').animations ?? []).map((a) => a.name);
    for (const c of USED_CLIPS) expect(names).toContain(c);
  });

  it('both bodies are skinned to the skeleton the rig drives', () => {
    for (const f of ['characters/soldier-m.glb', 'characters/soldier-f.glb']) {
      const j = glbJson(f);
      const joints = new Set(j.skins![0]!.joints.map((i) => j.nodes[i]!.name));
      for (const b of USED_BONES) expect(joints, `${f} ${b}`).toContain(b);
    }
  });

  it('every weapon class in the catalog has a model and a hold', () => {
    for (const w of Object.values(weaponCatalog)) {
      const id = MODEL_FOR_CLASS[w.class];
      expect(HOLDS[id], w.id).toBeDefined();
      expect(statSync(join(ASSETS, `weapons/${id}.glb`)).size, w.id).toBeGreaterThan(1000);
    }
  });

  it('all character and weapon files together stay under 2 MB', () => {
    let total = 0;
    for (const dir of ['characters', 'weapons'])
      for (const f of readdirSync(join(ASSETS, dir))) total += statSync(join(ASSETS, dir, f)).size;
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
});
