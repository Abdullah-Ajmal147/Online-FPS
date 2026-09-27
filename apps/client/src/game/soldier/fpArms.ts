import * as THREE from 'three/webgpu';
import { createSoldierModel, type SoldierAssets } from './assets.ts';
import { bodyMeshOf } from './outfit.ts';
import { gripClip, handOffsets, solveArmIK, type ArmBones } from './rig.ts';

/**
 * First-person arms: the player's own soldier (team uniform, gloves, arm band) cut down to the
 * arms, hanging from the camera, both hands put on the first-person weapon's grips with the same
 * two-bone IK the third-person soldiers use.
 */
const FP_ARM_SCALE = 1.3;

export class FirstPersonArms {
  readonly root: THREE.Object3D;
  private readonly right: ArmBones;
  private readonly left: ArmBones;
  private readonly offsets: { r: THREE.Quaternion; l: THREE.Quaternion };

  constructor(assets: SoldierAssets, team: number) {
    const model = createSoldierModel(assets, team, 0);
    this.root = model.root;
    const body = bodyMeshOf(this.root);
    body.geometry = armsOnly(body);
    // Only the arms: no head, eyes, gear.
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      if (mesh !== body) mesh.visible = false;
    });
    const bone = (n: string) => model.bones.get(n)!;
    // Viewmodel arms are drawn a bit larger than life (as in most shooters): at true size a
    // shoulder can't reach a long rifle's handguard the way the camera frames it.
    this.root.rotation.y = Math.PI;
    this.root.scale.setScalar(FP_ARM_SCALE);
    this.root.updateMatrixWorld(true);
    const len = (a: string, b: string) =>
      bone(a)
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(bone(b).getWorldPosition(new THREE.Vector3()));
    const arm = (s: 'r' | 'l'): ArmBones => ({
      upper: bone(`upperarm_${s}`),
      lower: bone(`lowerarm_${s}`),
      hand: bone(`hand_${s}`),
      a: len(`upperarm_${s}`, `lowerarm_${s}`),
      b: len(`lowerarm_${s}`, `hand_${s}`),
      between: [],
    });
    this.right = arm('r');
    this.left = arm('l');
    this.offsets = handOffsets(assets);
    // Fingers closed round the grips (a one-frame pose; the IK never moves fingers).
    const mixer = new THREE.AnimationMixer(this.root);
    mixer.clipAction(gripClip(assets)).play();
    mixer.update(0);
    // Shoulders just below and behind the eye; the body faces the camera's forward (-Z).
    const mid = bone('upperarm_r')
      .getWorldPosition(new THREE.Vector3())
      .add(bone('upperarm_l').getWorldPosition(new THREE.Vector3()))
      .multiplyScalar(0.5);
    this.root.position.set(-mid.x, -0.24 - mid.y, -0.04 - mid.z);
  }

  /** Hands onto the weapon: wrist points in weapon space, weapon already placed this frame. */
  grip(weapon: THREE.Object3D, right: THREE.Vector3Tuple, left: THREE.Vector3Tuple): void {
    // Everything hangs off the camera; bring the camera's subtree up to date first.
    this.root.parent!.updateWorldMatrix(true, true);
    const wm = weapon.matrixWorld;
    const q = weapon.getWorldQuaternion(new THREE.Quaternion());
    const camQ = this.root.parent!.getWorldQuaternion(new THREE.Quaternion());
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(camQ);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(camQ);
    const pole = (arm: ArmBones, s: number) =>
      arm.upper
        .getWorldPosition(new THREE.Vector3())
        .addScaledVector(down, 1)
        .addScaledVector(side, s);
    solveArmIK(
      this.right,
      new THREE.Vector3(...right).applyMatrix4(wm),
      pole(this.right, 0.8),
      q.clone().multiply(this.offsets.r),
    );
    solveArmIK(
      this.left,
      new THREE.Vector3(...left).applyMatrix4(wm),
      pole(this.left, -0.8),
      q.clone().multiply(this.offsets.l),
    );
  }
}

/** The body geometry reduced to the triangles the arms move (hands, forearms, upper arms). */
function armsOnly(body: THREE.SkinnedMesh): THREE.BufferGeometry {
  const geo = body.geometry.clone();
  const bones = body.skeleton.bones;
  const idx = geo.attributes.skinIndex!;
  const w = geo.attributes.skinWeight!;
  const arm = new Uint8Array(idx.count);
  for (let i = 0; i < idx.count; i++) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (w.getComponent(i, k) > w.getComponent(i, best)) best = k;
    arm[i] = /^(upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)_/.test(
      bones[idx.getComponent(i, best)]!.name,
    )
      ? 1
      : 0;
  }
  const index = geo.index!;
  const keep: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    if (arm[a] && arm[b] && arm[c]) keep.push(a, b, c);
  }
  geo.setIndex(keep);
  geo.clearGroups();
  geo.addGroup(0, keep.length, 1); // clothing material (sleeves, gloves, band)
  return geo;
}
