import * as THREE from 'three/webgpu';
import type { RemotePose } from '@sentinel/shared';
import { createSoldierModel, type SoldierAssets, type SoldierModel } from './assets.ts';
import { movement } from '@sentinel/content';
import { HOLDS, type WeaponModelId } from './holds.ts';

/**
 * Animates one soldier from the pose the server sends (position, yaw, pitch, crouch, alive):
 *
 * - Legs: locomotion clips (idle, walk, jog, sprint, crouch) blended by the speed the soldier
 *   actually moves at, all on one shared step cycle so blends don't make the feet slide. Moving
 *   sideways turns the hips toward the movement (up to 75°) while the chest keeps facing the aim;
 *   moving backwards plays the cycle in reverse.
 * - Upper body: the spine bends to the aim pitch; the weapon is placed at the shoulder along the
 *   aim, and both arms reach it with two-bone IK (so every weapon is held properly with the same
 *   few clips). Fingers keep a grip pose.
 * - Death: the death clip on the whole body; the weapon stays in the right hand.
 *
 * Purely visual: nothing here affects hits (the server's hitboxes are fixed capsules; the models
 * are fitted to them, see the soldier tests).
 */

const LOCO = [
  'Idle_Loop',
  'Walk_Loop',
  'Jog_Fwd_Loop',
  'Sprint_Loop',
  'Crouch_Idle_Loop',
  'Crouch_Fwd_Loop',
];
/** How fast each clip moves the body at normal playback (m/s), measured from its footfalls. */
const NATIVE_SPEED: Record<string, number> = {
  Walk_Loop: 1.45,
  Jog_Fwd_Loop: 3.6,
  Sprint_Loop: 6.2,
  Crouch_Fwd_Loop: 1.25,
};
const ARM_OR_HAND = /^(clavicle|upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)_/;
const FINGER = /^(index|middle|ring|pinky|thumb)_/;

interface PreparedClips {
  /** Locomotion without arm tracks (the arms follow the weapon). */
  loco: Map<string, THREE.AnimationClip>;
  /** Static finger grip, from the pistol pose. */
  grip: THREE.AnimationClip;
  fall: THREE.AnimationClip;
  death: THREE.AnimationClip;
  /** Hand orientation relative to the weapon, taken from the pistol aim pose. */
  handOffset: { r: THREE.Quaternion; l: THREE.Quaternion } | null;
}

let prepared: PreparedClips | null = null;

const boneOf = (track: THREE.KeyframeTrack) => track.name.split('.')[0]!;

function prepareClips(assets: SoldierAssets): PreparedClips {
  if (prepared) return prepared;
  const clip = (name: string) => {
    const c = assets.clips.get(name);
    if (!c) throw new Error(`animation ${name} missing`);
    return c;
  };
  const loco = new Map<string, THREE.AnimationClip>();
  for (const name of LOCO) {
    const c = clip(name);
    loco.set(
      name,
      new THREE.AnimationClip(
        name,
        c.duration,
        c.tracks.filter((t) => !ARM_OR_HAND.test(boneOf(t))),
      ),
    );
  }
  const pistol = clip('Pistol_Idle_Loop');
  const grip = new THREE.AnimationClip(
    'grip',
    -1,
    pistol.tracks
      .filter((t) => FINGER.test(boneOf(t)))
      .map((t) => {
        const T = t.constructor as new (
          n: string,
          times: number[],
          values: number[],
        ) => THREE.KeyframeTrack;
        return new T(t.name, [0], Array.from(t.values.slice(0, t.getValueSize())));
      }),
  );
  const fall = clip('Jump_Loop');
  fall.tracks = fall.tracks.filter((t) => !ARM_OR_HAND.test(boneOf(t)));
  prepared = { loco, grip, fall, death: clip('Death01'), handOffset: null };
  return prepared;
}

// Scratch objects (no allocation per frame).
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const qC = new THREE.Quaternion();
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const vD = new THREE.Vector3();
const vS = new THREE.Vector3();
const mA = new THREE.Matrix4();
const eA = new THREE.Euler();
const qHips = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// The IK below moves a few bones at a time. Instead of recomputing whole sub-skeletons after
// each move (three.js's updateMatrixWorld), each step refreshes exactly the bones it will read
// next ("chain"); the renderer's own pass brings everything else up to date once per frame.

/** Recompute one bone's world matrix from its parent's (which must be current). */
function refresh(b: THREE.Object3D): void {
  b.matrix.compose(b.position, b.quaternion, b.scale);
  b.matrixWorld.multiplyMatrices(b.parent!.matrixWorld, b.matrix);
}

const worldPos = (b: THREE.Object3D, out: THREE.Vector3) =>
  out.setFromMatrixPosition(b.matrixWorld);
const worldQuat = (b: THREE.Object3D, out: THREE.Quaternion) => {
  b.matrixWorld.decompose(vD, out, vS);
  return out;
};

/** Set a bone's world orientation, then refresh it and `chain`. */
function setWorldQuaternion(
  bone: THREE.Object3D,
  q: THREE.Quaternion,
  chain: THREE.Object3D[] = [],
): void {
  bone.quaternion.copy(worldQuat(bone.parent!, qC).invert().multiply(q));
  refresh(bone);
  for (const c of chain) refresh(c);
}

/** Turn `bone` in world space by `q`, then refresh it and `chain`. */
function rotateWorld(
  bone: THREE.Object3D,
  q: THREE.Quaternion,
  chain: THREE.Object3D[] = [],
): void {
  setWorldQuaternion(bone, worldQuat(bone, qB).premultiply(q), chain);
}

/** Point `bone` so that `child` lies towards world point `to`. */
function aimBone(
  bone: THREE.Object3D,
  child: THREE.Object3D,
  to: THREE.Vector3,
  chain: THREE.Object3D[],
): void {
  const from = worldPos(bone, vA);
  const cur = worldPos(child, vB).sub(from).normalize();
  const want = vC.copy(to).sub(from).normalize();
  rotateWorld(bone, qA.setFromUnitVectors(cur, want), chain);
}

export interface Arm {
  upper: THREE.Bone;
  lower: THREE.Bone;
  hand: THREE.Bone;
  a: number;
  b: number;
  /** Bones between `lower` and `hand` (none for arms; the neck for the spine). */
  between: THREE.Bone[];
  /** Bones to refresh after moving `upper` / `lower` (worked out on first use). */
  chains?: [THREE.Object3D[], THREE.Object3D[]];
}

const ikS = new THREE.Vector3();
const ikU = new THREE.Vector3();
const ikN = new THREE.Vector3();
const ikE = new THREE.Vector3();
const ikT = new THREE.Vector3();

/**
 * Two-bone IK: put `hand` on `target`, the middle joint bending towards `pole`. Law of cosines
 * for the first angle; the chain is straightened (not stretched) when out of reach.
 */
function solveArm(arm: Arm, target: THREE.Vector3, pole: THREE.Vector3): void {
  const s = worldPos(arm.upper, ikS);
  const u = ikU.copy(target).sub(s);
  const d = Math.min(u.length(), (arm.a + arm.b) * 0.999);
  u.normalize();
  const cosA = Math.max(-1, Math.min(1, (arm.a * arm.a + d * d - arm.b * arm.b) / (2 * arm.a * d)));
  const n = ikN.copy(pole).sub(s);
  n.addScaledVector(u, -n.dot(u)).normalize();
  const elbow = ikE
    .copy(s)
    .addScaledVector(u, arm.a * cosA)
    .addScaledVector(n, arm.a * Math.sqrt(1 - cosA * cosA));
  if (!arm.chains) {
    const rest = [...arm.between, arm.hand];
    arm.chains = [[...chainBetween(arm.upper, arm.lower), arm.lower, ...rest], rest];
  }
  aimBone(arm.upper, arm.lower, elbow, arm.chains[0]);
  aimBone(arm.lower, arm.hand, ikT.copy(s).addScaledVector(u, d), arm.chains[1]);
}

/** Bones strictly between `from` and its descendant `to` (e.g. spine_02 between 01 and 03). */
function chainBetween(from: THREE.Object3D, to: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (let p = to.parent; p && p !== from; p = p.parent) out.unshift(p);
  return out;
}

export type ArmBones = Arm;

/** Two-bone IK for an arm, then the hand turned to `handQ` (world). Bones must be current. */
export function solveArmIK(
  arm: Arm,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  handQ: THREE.Quaternion,
): void {
  solveArm(arm, target, pole);
  setWorldQuaternion(arm.hand, handQ);
}

/** The static finger grip pose (from the pistol clip). */
export function gripClip(assets: SoldierAssets): THREE.AnimationClip {
  return prepareClips(assets).grip;
}

/** How the hands sit on a weapon (measured once from the pistol aim clip). */
export function handOffsets(assets: SoldierAssets): { r: THREE.Quaternion; l: THREE.Quaternion } {
  if (!prepared?.handOffset) {
    // Measured by the first rig built; build a throwaway one if none exists yet.
    new SoldierRig(assets, createSoldierModel(assets, 0, 0)).dispose();
  }
  return prepared!.handOffset!;
}

export class SoldierRig {
  readonly root: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly loco = new Map<string, THREE.AnimationAction>();
  private readonly fall: THREE.AnimationAction;
  private readonly death: THREE.AnimationAction;
  private readonly bones: Map<string, THREE.Bone>;
  private readonly armR: Arm;
  private readonly armL: Arm;
  private weapon: THREE.Object3D | null = null;
  private weaponId: WeaponModelId | null = null;
  private readonly weaponLength = new Map<string, number>();

  // Motion state, smoothed.
  private last: THREE.Vector3 | null = null;
  private vel = new THREE.Vector3();
  private vy = 0;
  private crouch = 0;
  private legYaw = 0;
  private phase = 0;
  private dead = false;
  /** Seconds since death (the dropped weapon's fall, then sinking away). */
  private deadFor = 0;
  private drop: {
    from: THREE.Vector3;
    fromQ: THREE.Quaternion;
    toQ: THREE.Quaternion;
    floor: number;
  } | null = null;
  private kick = 0;
  /** Head centre in the Head bone's space (measured in the rest pose). */
  private readonly headCentre: THREE.Vector3;
  /** Head orientation relative to the aim frame (rest pose: looking straight ahead). */
  private readonly headOffset: THREE.Quaternion;
  private readonly spine: Arm;
  /** Clavicles and upper arms: refreshed after the spine moves, before the arm IK. */
  private readonly shoulders: THREE.Bone[];
  private readonly upperChain: THREE.Bone[];
  private readonly spineChain: THREE.Bone[];
  /** Pelvis position in the rest pose (bone space). */
  private readonly restPelvis: THREE.Vector3;

  constructor(
    private readonly assets: SoldierAssets,
    readonly model: SoldierModel,
  ) {
    this.root = model.root;
    this.bones = model.bones;
    const clips = prepareClips(assets);
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const [name, clip] of clips.loco) {
      const a = this.mixer.clipAction(clip);
      a.play();
      a.timeScale = 0; // time set by hand: one shared step cycle
      a.setEffectiveWeight(0);
      this.loco.set(name, a);
    }
    this.mixer.clipAction(clips.grip).play();
    this.fall = this.mixer.clipAction(clips.fall);
    this.fall.play();
    this.fall.setEffectiveWeight(0);
    this.death = this.mixer.clipAction(clips.death);
    this.death.setLoop(THREE.LoopOnce, 1);
    this.death.clampWhenFinished = true;
    const b = (n: string) => {
      const bone = this.bones.get(n);
      if (!bone) throw new Error(`bone ${n} missing`);
      return bone;
    };
    this.root.updateMatrixWorld(true);
    // Rest pose: the head's centre is ~10 cm above the Head bone (at the base of the skull).
    const headBone = b('Head');
    const restHead = headBone.getWorldPosition(new THREE.Vector3());
    this.headCentre = headBone.worldToLocal(restHead.clone().add(new THREE.Vector3(0, 0.1, 0.02)));
    // The model faces +Z at rest; the aim frame's forward is -Z: a half turn.
    this.headOffset = new THREE.Quaternion()
      .setFromAxisAngle(UP, Math.PI)
      .invert()
      .multiply(headBone.getWorldQuaternion(new THREE.Quaternion()));
    const len = (x: string, y: string) =>
      b(x)
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(b(y).getWorldPosition(new THREE.Vector3()));
    this.armR = {
      upper: b('upperarm_r'),
      lower: b('lowerarm_r'),
      hand: b('hand_r'),
      a: len('upperarm_r', 'lowerarm_r'),
      b: len('lowerarm_r', 'hand_r'),
      between: [],
    };
    this.armL = {
      upper: b('upperarm_l'),
      lower: b('lowerarm_l'),
      hand: b('hand_l'),
      a: len('upperarm_l', 'lowerarm_l'),
      b: len('lowerarm_l', 'hand_l'),
      between: [],
    };
    this.restPelvis = b('pelvis').position.clone();
    this.spine = {
      upper: b('spine_01'),
      lower: b('spine_03'),
      hand: b('Head'),
      a: len('spine_01', 'spine_03'),
      b: len('spine_03', 'Head'),
      between: [b('neck_01')],
    };
    this.shoulders = [b('clavicle_r'), b('upperarm_r'), b('clavicle_l'), b('upperarm_l')];
    this.upperChain = ['spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head'].map(b);
    this.spineChain = this.upperChain.slice(1);
    clips.handOffset ??= this.measureHandOffsets();
  }

  /**
   * How each hand sits on a gun: in the pistol aim clip the character (facing +Z) holds a
   * pistol pointing straight ahead with both hands. Hand orientation relative to that pistol
   * is what we keep for every weapon.
   */
  private measureHandOffsets(): { r: THREE.Quaternion; l: THREE.Quaternion } {
    const aim = this.assets.clips.get('Pistol_Aim_Neutral')!;
    const action = this.mixer.clipAction(aim);
    action.play();
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
    // The pistol points +Z in model space; our weapon models point -Z: a half turn.
    const gunInv = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI).invert();
    const rootInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const hand = (bone: THREE.Bone) =>
      gunInv
        .clone()
        .multiply(rootInv.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion())));
    const out = { r: hand(this.armR.hand), l: hand(this.armL.hand) };
    action.stop();
    this.mixer.uncacheAction(aim);
    return out;
  }

  /** Show `id`'s model in the hands (null = none). */
  setWeapon(id: WeaponModelId | null): void {
    if (id === this.weaponId) return;
    this.weaponId = id;
    this.weapon?.removeFromParent();
    this.weapon = null;
    const src = id ? this.assets.weapons.get(id) : undefined;
    if (!id || !src) return;
    this.weapon = src.clone();
    this.weapon.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.root.parent?.add(this.weapon);
    if (!this.weaponLength.has(id)) {
      const box = new THREE.Box3().setFromObject(src);
      this.weaponLength.set(id, box.max.z - box.min.z);
    }
  }

  /** A shot: a short kick back along the aim. */
  fired(): void {
    this.kick = 1;
  }

  /** World position of the muzzle (for tracers), or null if no weapon is drawn. */
  muzzle(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.weapon || !this.weaponId || this.dead) return null;
    const h = HOLDS[this.weaponId];
    return out.set(0, h.muzzle[1], h.muzzle[2]).applyMatrix4(this.weapon.matrixWorld);
  }

  /** Centre of the drawn head (world). */
  head(out: THREE.Vector3): THREE.Vector3 {
    return this.bones.get('Head')!.localToWorld(out.copy(this.headCentre));
  }

  get visible(): boolean {
    return this.root.visible;
  }

  set visible(v: boolean) {
    this.root.visible = v;
    if (this.weapon) this.weapon.visible = v;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    this.weapon?.removeFromParent();
  }

  update(pose: RemotePose, dt: number, detail: boolean): void {
    const [x, y, z] = pose.position;
    this.root.position.set(x, y, z);
    // The model faces +Z; yaw 0 faces -Z.
    this.root.rotation.y = pose.yaw + Math.PI;

    // Velocity from where we are drawn (smoothed; a jump in position is a respawn).
    if (this.last && dt > 0) {
      const dx = (x - this.last.x) / dt;
      const dy = (y - this.last.y) / dt;
      const dz = (z - this.last.z) / dt;
      if (Math.hypot(dx, dz) > 20) this.vel.set(0, 0, 0);
      else this.vel.lerp(vA.set(dx, 0, dz), 1 - Math.exp(-dt * 12));
      this.vy += (dy - this.vy) * (1 - Math.exp(-dt * 10));
    }
    (this.last ??= new THREE.Vector3()).set(x, y, z);
    this.crouch += ((pose.crouching ? 1 : 0) - this.crouch) * (1 - Math.exp(-dt * 12));

    if (!pose.alive) {
      if (!this.dead) this.die();
      this.deadFor += dt;
      this.mixer.update(dt);
      this.animateDrop();
      // Stay down a moment, then sink out of sight (no bodies piling up).
      const sink = Math.max(0, this.deadFor - 2.2) * 0.6;
      this.root.position.y = y - sink;
      this.root.visible = this.deadFor < 3.2;
      if (this.weapon) this.weapon.visible = this.root.visible;
      return;
    }
    if (this.dead) this.revive();

    const speed = Math.hypot(this.vel.x, this.vel.z);
    // Direction of travel relative to facing: 0 = forward, ±π = backward.
    const facing = pose.yaw;
    const moveYaw = Math.atan2(-this.vel.x, -this.vel.z);
    let rel = moveYaw - facing;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const backwards = speed > 0.4 && Math.abs(rel) > (100 * Math.PI) / 180;
    let hips = backwards ? rel - Math.sign(rel) * Math.PI : rel;
    hips = speed > 0.4 ? Math.max(-1.3, Math.min(1.3, hips)) : 0;
    this.legYaw += (hips - this.legYaw) * (1 - Math.exp(-dt * 8));

    // Blend weights along the speed axis, standing and crouched.
    const w = new Map<string, number>(LOCO.map((n) => [n, 0]));
    const stand = 1 - this.crouch;
    const pts: [string, number][] = [
      ['Idle_Loop', 0],
      ['Walk_Loop', 1.6],
      ['Jog_Fwd_Loop', 4.6],
      ['Sprint_Loop', 7.2],
    ];
    const s = Math.min(speed, 7.2);
    for (let i = 0; i < pts.length - 1; i++) {
      const [na, sa] = pts[i]!;
      const [nb, sb] = pts[i + 1]!;
      if (s >= sa && s <= sb) {
        const t = (s - sa) / (sb - sa);
        w.set(na, (1 - t) * stand);
        w.set(nb, t * stand);
        break;
      }
    }
    const c = Math.min(1, speed / 1.6);
    w.set('Crouch_Idle_Loop', (1 - c) * this.crouch);
    w.set('Crouch_Fwd_Loop', c * this.crouch);
    const airborne = Math.abs(this.vy) > 1.2 ? 1 : 0;
    this.fall.setEffectiveWeight(airborne);

    // One step cycle for every clip: advance by the weighted cadence of the moving clips.
    let cadence = 0;
    let moving = 0;
    for (const [name, native] of Object.entries(NATIVE_SPEED)) {
      const wi = w.get(name) ?? 0;
      if (wi <= 0) continue;
      const clip = this.loco.get(name)!.getClip();
      const rate = Math.max(0.6, Math.min(1.6, speed / native));
      cadence += wi * (rate / clip.duration);
      moving += wi;
    }
    if (moving > 0) this.phase += (backwards ? -1 : 1) * (cadence / moving) * dt;
    else this.phase += dt / 2.5; // idle breathing
    this.phase -= Math.floor(this.phase);
    for (const [name, a] of this.loco) {
      a.setEffectiveWeight((w.get(name) ?? 0) * (1 - airborne));
      a.time = this.phase * a.getClip().duration;
    }
    this.mixer.update(dt);
    // The jog and sprint clips run low (knees bent, hips down): raise the hips most of the way
    // back to standing height so the head can reach its hitbox without the back arching.
    const running = (w.get('Jog_Fwd_Loop') ?? 0) + (w.get('Sprint_Loop') ?? 0);
    if (running > 0) this.bones.get('pelvis')!.position.lerp(this.restPelvis, 0.6 * running);
    this.root.updateMatrixWorld(true);

    // Hips toward the movement, chest back to the aim.
    const pelvis = this.bones.get('pelvis')!;
    const spine1 = this.bones.get('spine_01')!;
    if (Math.abs(this.legYaw) > 1e-3) {
      rotateWorld(pelvis, qHips.setFromAxisAngle(UP, this.legYaw), this.upperChain);
      rotateWorld(spine1, qHips.setFromAxisAngle(UP, -this.legYaw), this.spineChain);
    }
    if (!detail) return; // far away: legs only, no arm IK
    this.aimUpperBody(pose, dt);
  }

  // Per-rig scratch for the aim pass.
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly flat = new THREE.Vector3();
  private readonly aim = new THREE.Quaternion();
  private readonly gunQ = new THREE.Quaternion();
  private readonly t1 = new THREE.Vector3();
  private readonly t2 = new THREE.Vector3();
  private readonly t3 = new THREE.Vector3();

  private aimUpperBody(pose: RemotePose, dt: number): void {
    // Aim frame: forward along the view (with pitch), right, up.
    const cp = Math.cos(pose.pitch);
    const fwd = this.fwd.set(
      -Math.sin(pose.yaw) * cp,
      Math.sin(pose.pitch),
      -Math.cos(pose.yaw) * cp,
    );
    const right = this.right.set(Math.cos(pose.yaw), 0, -Math.sin(pose.yaw));
    const up = this.up.crossVectors(right, fwd).normalize();
    const flat = this.flat.set(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw));
    const aim = this.aim.setFromRotationMatrix(mA.makeBasis(right, up, vA.copy(fwd).negate()));

    // Hit where you see: whatever the clip does (running lean, deep crouch), the spine bends
    // so the drawn head sits on the server's head hitbox (0.9 × capsule height above the feet,
    // centred over them). Two-bone IK over the spine; the back curls forward, never sideways.
    const height = THREE.MathUtils.lerp(
      movement.standingHeight,
      movement.crouchHeight,
      this.crouch,
    );
    const headBone = this.spine.hand;
    const centre = this.t1.copy(this.headCentre).applyMatrix4(headBone.matrixWorld);
    const boneTarget = this.t2
      .copy(this.root.position)
      .setY(this.root.position.y + height * 0.9)
      .sub(centre.sub(worldPos(headBone, vD)));
    const pole = worldPos(this.spine.upper, this.t3)
      .addScaledVector(flat, 1)
      .addScaledVector(UP, 0.3);
    solveArm(this.spine, boneTarget, pole);
    // The head looks along the aim.
    setWorldQuaternion(headBone, qA.copy(aim).multiply(this.headOffset));
    for (const b of this.shoulders) refresh(b);

    if (!this.weapon || !this.weaponId) return;
    const hold = HOLDS[this.weaponId];
    const sprinting = Math.hypot(this.vel.x, this.vel.z) > 6.5 && this.crouch < 0.5;
    this.kick = Math.max(0, this.kick - dt * 12);

    // Weapon: from the chest along the aim (lowered and turned in while sprinting).
    const q = this.gunQ.copy(aim);
    if (sprinting) q.multiply(qA.setFromEuler(eA.set(-0.7, 0.6, 0)));
    worldPos(this.spine.lower, this.weapon.position)
      .addScaledVector(right, hold.at[0])
      .addScaledVector(up, hold.at[1] - (sprinting ? 0.12 : 0))
      .addScaledVector(fwd, hold.at[2] - this.kick * hold.kick);
    this.weapon.quaternion.copy(q);
    this.weapon.updateMatrix();
    this.weapon.matrixWorld.copy(this.weapon.matrix); // a child of the scene root
    for (const c of this.weapon.children) c.updateMatrixWorld(true);

    // Arms reach the weapon: wrists to the grip points, elbows down and out.
    const offsets = prepared!.handOffset!;
    const wm = this.weapon.matrixWorld;
    const shoulderR = worldPos(this.armR.upper, this.t3);
    solveArm(
      this.armR,
      this.t1.set(...hold.right).applyMatrix4(wm),
      shoulderR.addScaledVector(up, -1).addScaledVector(right, 0.6).addScaledVector(fwd, -0.3),
    );
    const shoulderL = worldPos(this.armL.upper, this.t3);
    solveArm(
      this.armL,
      this.t1.set(...hold.left).applyMatrix4(wm),
      shoulderL.addScaledVector(up, -1).addScaledVector(right, -0.9),
    );
    setWorldQuaternion(this.armR.hand, qA.copy(q).multiply(offsets.r));
    setWorldQuaternion(
      this.armL.hand,
      qA
        .copy(q)
        .multiply(offsets.l)
        .multiply(qB.setFromEuler(eA.set(...hold.leftTwist))),
    );
  }

  private die(): void {
    this.dead = true;
    this.deadFor = 0;
    for (const a of this.loco.values()) a.setEffectiveWeight(0);
    this.fall.setEffectiveWeight(0);
    this.death.reset().setEffectiveWeight(1).play();
    this.legYaw = 0;
    // The weapon slips from the hands and falls flat, same heading.
    if (this.weapon) {
      const q = this.weapon.quaternion.clone();
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      this.drop = {
        from: this.weapon.position.clone(),
        fromQ: q,
        toQ: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, e.y, Math.PI / 2, 'YXZ')),
        floor: this.root.position.y + 0.04,
      };
    }
  }

  /** Dropped weapon: falls under gravity and turns onto its side in ~0.45 s. */
  private animateDrop(): void {
    if (!this.weapon || !this.drop) return;
    const t = Math.min(this.deadFor, 0.45);
    const d = this.drop;
    this.weapon.position.set(d.from.x, Math.max(d.floor, d.from.y - 4.9 * t * t), d.from.z);
    this.weapon.quaternion.slerpQuaternions(d.fromQ, d.toQ, t / 0.45);
  }

  private revive(): void {
    this.dead = false;
    this.drop = null;
    this.death.stop();
    this.root.visible = true;
    if (this.weapon) this.weapon.visible = true;
    this.last = null;
    this.vel.set(0, 0, 0);
  }
}
