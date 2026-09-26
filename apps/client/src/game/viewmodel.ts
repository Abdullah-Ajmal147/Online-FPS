import type { Weapon } from '@sentinel/content';
import * as THREE from 'three/webgpu';

/**
 * First-person weapon, built from simple shapes (greybox; real models come with the content
 * pipeline in Phase 5). Hangs off the camera; kicks back on each shot, moves to the centre when
 * aiming, dips during reload and drops out/in on weapon switch.
 */
export class Viewmodel {
  readonly root = new THREE.Group();
  /** One model per weapon class; the loadout picks which two are used. */
  private readonly models: Record<Weapon['class'], THREE.Group>;
  private guns: [THREE.Group, THREE.Group];
  private kick = 0;
  private bobPhase = 0;
  private readonly flash: THREE.Mesh;

  constructor(camera: THREE.Camera) {
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
  }

  /** Show the models for this loadout (called when the server confirms our loadout). */
  setLoadout(primary: Weapon, secondary: Weapon): void {
    this.guns = [this.models[primary.class], this.models[secondary.class]];
  }

  onShot(): void {
    this.kick = 1;
    this.flash.visible = true;
  }

  /** World position of the muzzle (for tracers). */
  muzzleWorld(slot: number, out: THREE.Vector3): THREE.Vector3 {
    const gun = this.guns[slot]!;
    return gun.localToWorld(out.set(0, 0.02, gun.userData.muzzleZ as number));
  }

  update(
    frame: number,
    o: {
      slot: number;
      ads: number;
      reloading: number;
      switching: number;
      speed: number;
      grounded: boolean;
    },
  ): void {
    for (const g of Object.values(this.models)) g.visible = g === this.guns[o.slot];
    this.kick = Math.max(0, this.kick - frame * 14);
    if (this.flash.visible && this.kick < 0.6) this.flash.visible = false;
    if (o.grounded && o.speed > 0.5) this.bobPhase += frame * o.speed * 1.6;
    const bob = (1 - o.ads) * Math.min(1, o.speed / 5);

    // Hip position → centred down the sights as ADS goes 0 → 1.
    const hipX = 0.16;
    const hipY = -0.15;
    this.root.position.set(
      hipX * (1 - o.ads) + Math.sin(this.bobPhase) * 0.012 * bob,
      hipY +
        (1 - o.ads) * 0 +
        o.ads * 0.058 -
        Math.abs(Math.cos(this.bobPhase)) * 0.01 * bob -
        o.reloading * 0.12 -
        o.switching * 0.25,
      -0.32 + this.kick * 0.04,
    );
    this.root.rotation.set(this.kick * 0.06 - o.reloading * 0.6, 0, o.reloading * 0.3);
    const gun = this.guns[o.slot]!;
    this.flash.position.set(gun.position.x, 0.02, (gun.userData.muzzleZ as number) - 0.03);
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
