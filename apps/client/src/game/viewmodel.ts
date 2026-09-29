import type { Kick, Weapon } from '@sentinel/content';
import { KickSpring } from './kickSpring.ts';
import * as THREE from 'three/webgpu';
import { loadSoldierAssets, type SoldierAssets } from './soldier/assets.ts';
import { FirstPersonArms } from './soldier/fpArms.ts';
import { HOLDS, modelFor, WEAPON_MODEL_IDS, type WeaponModelId } from './soldier/holds.ts';

/**
 * First-person weapon. Hangs off the camera; kicks back on each shot, moves to the centre when
 * aiming, dips during reload and drops out/in on weapon switch. Drawn with the real weapon models
 * held by the player's own gloved arms once those load (soldier/), before that as simple shapes.
 */
/** Length of the melee strike animation, seconds. */
const MELEE_SECONDS = 0.35;

export class Viewmodel {
  readonly root = new THREE.Group();
  /** One model per weapon class; the loadout picks which two are used. */
  private readonly models: Record<Weapon['class'], THREE.Group>;
  private guns: [THREE.Group, THREE.Group];
  /** The gun's kick (springs pushed by each shot) and how long the flash still shows. */
  private readonly kick = new KickSpring();
  private flashLeft = 0;
  private bobPhase = 0;
  private readonly flash: THREE.Mesh;
  private readonly camera: THREE.Camera;
  /** Real models, one per weapon class (null until loaded). */
  private real: Record<WeaponModelId, THREE.Group> | null = null;
  /** Current loadout (primary, secondary); null until the server confirms one. */
  private loadout: [Weapon, Weapon] | null = null;
  private assets: SoldierAssets | null = null;
  private arms: FirstPersonArms | null = null;
  private armsTeam = -1;
  private team = 0;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    this.models = {
      rifle: buildRifle(),
      smg: buildSmg(),
      shotgun: buildShotgun(),
      marksman: buildMarksman(),
      sidearm: buildSidearm(),
    };
    for (const g of Object.values(this.models)) {
      g.visible = false;
      this.root.add(g);
    }
    this.guns = [this.models.rifle, this.models.sidearm];
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95 }),
    );
    this.flash.visible = false;
    this.root.add(this.flash);
    camera.add(this.root);
    loadSoldierAssets()
      .then((a) => {
        this.assets = a;
        this.buildReal(a);
      })
      .catch(() => undefined); // keep the simple shapes
  }

  /**
   * Real weapon models, placed inside the moving root so that, aiming down the sights (root at
   * x 0, y -0.092), the sight line is exactly at eye height.
   */
  private buildReal(assets: SoldierAssets): void {
    const real = {} as Record<WeaponModelId, THREE.Group>;
    for (const id of WEAPON_MODEL_IDS) {
      const src = assets.weapons.get(id);
      if (!src) return; // a model is missing: keep the simple shapes for all
      const g = new THREE.Group();
      const gun = src.clone();
      gun.scale.setScalar(HOLDS[id].fp.scale ?? 1);
      gun.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gun);
      const sight = box.max.y - HOLDS[id].fp.sightDrop;
      gun.position.set(0, 0.092 - sight, HOLDS[id].fp.z + 0.32);
      gun.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.frustumCulled = false;
        // Scope lenses: see-through here, or aiming would put a dark disc over the crosshair.
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (/glass/i.test(m.name)) {
          const lens = m.clone();
          lens.transparent = true;
          lens.opacity = 0.12;
          lens.depthWrite = false;
          mesh.material = lens;
        }
      });
      g.add(gun);
      g.visible = false;
      g.userData = {
        gun,
        id,
        muzzleZ: box.min.z + gun.position.z,
        muzzleY: sight - 0.02 + gun.position.y,
      };
      this.root.add(g);
      real[id] = g;
    }
    for (const g of Object.values(this.models)) g.visible = false;
    this.real = real;
    this.pickGuns();
  }

  /** The drawn guns for the loadout: real models per weapon, else simple shapes per class. */
  private pickGuns(): void {
    if (!this.loadout) {
      if (this.real) this.guns = [this.real.ar, this.real.sidearm];
      return;
    }
    const [p, s] = this.loadout;
    this.guns = this.real
      ? [this.real[modelFor(p)], this.real[modelFor(s)]]
      : [this.models[p.class], this.models[s.class]];
  }

  /** Our team (the arms wear its uniform). */
  setTeam(team: number): void {
    this.team = team;
  }

  /** Show the models for this loadout (called when the server confirms our loadout). */
  setLoadout(primary: Weapon, secondary: Weapon): void {
    this.loadout = [primary, secondary];
    this.pickGuns();
  }

  /** A shot: the gun kicks (by the weapon's kick, less when aiming) and flashes. */
  onShot(kick: Kick, ads: number): void {
    this.kick.fire(kick, ads, Math.random() * 2 - 1, Math.random() < 0.5 ? -1 : 1);
    this.flashLeft = 0.03;
    this.flash.visible = true;
  }

  /** A melee strike: the gun is driven forward and across (0.35 s). */
  melee(): void {
    this.meleeLeft = MELEE_SECONDS;
  }
  private meleeLeft = 0;

  /** World position of the muzzle (for tracers). */
  muzzleWorld(slot: number, out: THREE.Vector3): THREE.Vector3 {
    const gun = this.guns[slot]!;
    return gun.localToWorld(
      out.set(
        0,
        (gun.userData.muzzleY as number | undefined) ?? 0.02,
        gun.userData.muzzleZ as number,
      ),
    );
  }

  private swayYaw = 0;
  private swayPitch = 0;

  update(
    frame: number,
    o: {
      slot: number;
      ads: number;
      reloading: number;
      switching: number;
      speed: number;
      grounded: boolean;
      /** How far the view turned this frame (radians): the gun lags behind, then settles. */
      turnYaw: number;
      turnPitch: number;
      /** The drawn weapon's kick (feel.json), and sway / gun bob strength (1 = normal). */
      kick: Kick;
      sway: number;
      gunBob: number;
    },
  ): void {
    for (const g of Object.values(this.real ?? this.models)) g.visible = g === this.guns[o.slot];
    this.kick.update(frame, o.kick);
    this.flashLeft -= frame;
    if (this.flash.visible && this.flashLeft <= 0) this.flash.visible = false;
    const k5 = this.kick.offset; // back, up, pitch, yaw, roll
    this.meleeLeft = Math.max(0, this.meleeLeft - frame);
    // Strike curve: a fast drive out, a slower pull back (0 → 1 → 0).
    const mt = 1 - this.meleeLeft / MELEE_SECONDS;
    const strike = this.meleeLeft > 0 ? (mt < 0.35 ? mt / 0.35 : (1 - mt) / 0.65) : 0;
    const bash = strike * strike * (3 - 2 * strike);
    if (o.grounded && o.speed > 0.5) this.bobPhase += frame * o.speed * 1.6;
    const bob = (1 - o.ads) * Math.min(1, o.speed / 5) * o.gunBob;
    // Sway: the weapon trails fast turns a little (weight), much less when aiming.
    const hold = (1 - 0.75 * o.ads) * o.sway;
    const rate = frame > 0 ? 1 / frame : 0;
    const targetYaw = Math.max(-0.07, Math.min(0.07, o.turnYaw * rate * 0.01)) * hold;
    const targetPitch = Math.max(-0.05, Math.min(0.05, o.turnPitch * rate * 0.01)) * hold;
    const k = 1 - Math.exp(-frame * 10);
    this.swayYaw += (targetYaw - this.swayYaw) * k;
    this.swayPitch += (targetPitch - this.swayPitch) * k;

    // Hip position → centred down the sights as ADS goes 0 → 1.
    const hipX = 0.16;
    const hipY = -0.15;
    this.root.position.set(
      hipX * (1 - o.ads) + Math.sin(this.bobPhase) * 0.012 * bob - this.swayYaw * 0.18,
      hipY +
        (1 - o.ads) * 0 +
        o.ads * 0.058 -
        Math.abs(Math.cos(this.bobPhase)) * 0.01 * bob -
        o.reloading * 0.12 -
        o.switching * 0.25 +
        k5[1]! +
        bash * 0.05,
      -0.32 + k5[0]! - bash * 0.16,
    );
    this.root.rotation.set(
      k5[2]! - o.reloading * 0.6 - this.swayPitch - bash * 0.25,
      k5[3]! - this.swayYaw + bash * 0.55,
      k5[4]! + o.reloading * 0.3 + this.swayYaw * 0.6 + bash * 0.5,
    );
    const gun = this.guns[o.slot]!;
    this.flash.position.set(
      gun.position.x,
      (gun.userData.muzzleY as number | undefined) ?? 0.02,
      (gun.userData.muzzleZ as number) - 0.03,
    );
    this.updateArms(gun);
  }

  /** Gloved hands on the drawn weapon (built for our team when the models are ready). */
  private updateArms(shown: THREE.Group): void {
    if (!this.assets || !this.real) return;
    if (this.armsTeam !== this.team) {
      this.arms?.root.removeFromParent();
      this.arms = new FirstPersonArms(this.assets, this.team);
      this.armsTeam = this.team;
      this.camera.add(this.arms.root);
    }
    const arms = this.arms!;
    arms.root.visible = this.root.visible;
    if (!arms.root.visible) return;
    const id = shown.userData.id as keyof typeof HOLDS;
    const hold = HOLDS[id];
    // The grip points scale with the drawn weapon (they are in its space).
    arms.grip(shown.userData.gun as THREE.Object3D, hold.right, hold.left, hold.leftTwist);
  }
}

function part(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 }),
  );
  m.position.set(x, y, z);
  return m;
}

function buildRifle(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(0.05, 0.07, 0.42, 0x2b2f36)); // receiver
  g.add(part(0.025, 0.025, 0.2, 0x1b1e22, 0, 0.01, -0.3)); // barrel
  g.add(part(0.04, 0.12, 0.05, 0x3a3f47, 0, -0.08, -0.04)); // magazine
  g.add(part(0.045, 0.06, 0.16, 0x3a3f47, 0, -0.01, 0.25)); // stock
  g.add(part(0.02, 0.025, 0.06, 0x3b8cff, 0, 0.05, -0.02)); // sight (team-neutral accent)
  g.userData.muzzleZ = -0.41;
  return g;
}

function buildSidearm(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(0.035, 0.05, 0.18, 0x2b2f36, 0, 0.01, -0.04)); // slide
  g.add(part(0.03, 0.09, 0.05, 0x3a3f47, 0, -0.05, 0.02)); // grip
  g.add(part(0.012, 0.015, 0.02, 0xff8a3d, 0, 0.045, -0.1)); // front sight
  g.userData.muzzleZ = -0.14;
  return g;
}

function buildSmg(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(0.05, 0.075, 0.3, 0x30343b)); // compact receiver
  g.add(part(0.022, 0.022, 0.1, 0x1b1e22, 0, 0.012, -0.2)); // short barrel
  g.add(part(0.035, 0.16, 0.04, 0x3a3f47, 0, -0.1, -0.02)); // long magazine
  g.add(part(0.03, 0.03, 0.14, 0x3a3f47, 0, 0, 0.2)); // folding stock
  g.add(part(0.02, 0.025, 0.05, 0x3b8cff, 0, 0.05, 0)); // sight
  g.userData.muzzleZ = -0.26;
  return g;
}

function buildShotgun(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(0.055, 0.07, 0.34, 0x3a2f28)); // receiver
  g.add(part(0.035, 0.035, 0.34, 0x1b1e22, 0, 0.015, -0.32)); // wide barrel
  g.add(part(0.045, 0.045, 0.16, 0x5a4636, 0, -0.035, -0.26)); // pump
  g.add(part(0.05, 0.08, 0.2, 0x5a4636, 0, -0.02, 0.26)); // stock
  g.add(part(0.012, 0.015, 0.02, 0xff8a3d, 0, 0.04, -0.48)); // bead sight
  g.userData.muzzleZ = -0.5;
  return g;
}

function buildMarksman(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(0.05, 0.07, 0.46, 0x2d3530)); // receiver
  g.add(part(0.022, 0.022, 0.3, 0x1b1e22, 0, 0.01, -0.38)); // long barrel
  g.add(part(0.04, 0.09, 0.05, 0x3a3f47, 0, -0.07, -0.04)); // magazine
  g.add(part(0.05, 0.07, 0.18, 0x3a3f47, 0, -0.01, 0.27)); // stock
  g.add(part(0.035, 0.035, 0.16, 0x15181c, 0, 0.065, -0.02)); // scope tube
  g.add(part(0.03, 0.01, 0.01, 0x3b8cff, 0, 0.065, -0.1)); // scope lens accent
  g.userData.muzzleZ = -0.53;
  return g;
}
