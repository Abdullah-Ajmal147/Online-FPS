import * as THREE from 'three/webgpu';
import { movement } from '@sentinel/content';
import type { RemotePose } from '@sentinel/shared';
import type { Weapon } from '@sentinel/content';
import { createSoldierModel, loadSoldierAssets, type SoldierAssets } from './soldier/assets.ts';
import { MODEL_FOR_CLASS, type WeaponModelId } from './soldier/holds.ts';

const WEAPON_MODELS: WeaponModelId[] = ['rifle', 'smg', 'shotgun', 'marksman', 'sidearm'];
import { SoldierRig } from './soldier/rig.ts';

/** Faction colours from docs/GAME_DESIGN.md: Aegis Directive blue, Ember Syndicate orange. */
const TEAM_COLORS = [0x2f7bff, 0xff7a1f];
const TEAM_DARK = [0x1b3566, 0x6b3310];

interface Remote {
  root: THREE.Group;
  body: THREE.Group;
  /** Materials that flash when this player is hit. */
  flashMats: THREE.MeshStandardMaterial[];
  flashUntil: number;
  alive: boolean;
  /** Seconds since death (drives the fall), -1 while alive. */
  deadFor: number;
}

/** A drawn player: the animated soldier model, or the simple shape soldier until it loads. */
interface Drawn {
  team: number;
  rig: SoldierRig | null;
  simple: Remote | null;
  flashUntil: number;
  weapon: WeaponModelId | null;
}

/**
 * Other players. Drawn as animated soldier models (soldier/: dressed body, locomotion and aim,
 * weapon held with IK) once those load in the background; until then (or if they can't load) as
 * a simple original soldier built from shapes. Hit → white flash; death → fall, then sink away.
 */
export class RemotePlayers {
  /** Soldiers cast shadows only where shadows are redrawn every frame (High). */
  static castShadows = true;
  /** Beyond this distance soldiers animate legs only (no aim or arm IK): too small to see. */
  static detailDistance = 35;

  private drawn = new Map<number, Drawn>();
  private assets: SoldierAssets | null = null;
  /** Camera position, for the level of detail. */
  readonly viewer = new THREE.Vector3();

  /** Model soldiers built this frame (swapping 11 at once would be one long frame). */
  private builtThisFrame = 0;

  constructor(
    private readonly scene: THREE.Scene,
    renderer?: THREE.WebGPURenderer,
    camera?: THREE.Camera,
  ) {
    loadSoldierAssets()
      .then((a) => this.warm(a, renderer, camera))
      .then((a) => {
        this.assets = a;
      })
      .catch((e: unknown) => console.warn('[soldiers] models unavailable, using simple shapes', e));
  }

  /**
   * Before any soldier appears: dress every body/team combination (the one slow step, ~20 ms
   * each on a laptop) and let the renderer set up their materials in the background. Done a
   * piece at a time so frames keep coming. Without this the first enemies on screen froze the
   * game for a moment (measured: 0.7 s to dress + 0.46 s of shader setup on a slow machine).
   */
  private async warm(
    assets: SoldierAssets,
    renderer?: THREE.WebGPURenderer,
    camera?: THREE.Camera,
  ): Promise<SoldierAssets> {
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
    const group = new THREE.Group();
    group.position.set(0, -400, 0); // compiled, never seen
    const rigs: SoldierRig[] = [];
    for (const [team, variant] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const model = createSoldierModel(assets, team, variant);
      const rig = new SoldierRig(assets, model);
      group.add(model.root);
      rig.setWeapon(WEAPON_MODELS[rigs.length % WEAPON_MODELS.length]!);
      rigs.push(rig);
      await yieldFrame();
    }
    // Every weapon model once.
    for (const id of WEAPON_MODELS) {
      const w = assets.weapons.get(id);
      if (w) group.add(w.clone());
    }
    if (renderer && camera) {
      this.scene.add(group);
      await renderer.compileAsync(group, camera, this.scene).catch(() => undefined);
      this.scene.remove(group);
    }
    for (const r of rigs) r.dispose();
    return assets;
  }

  /** Call once per frame before the updates. */
  beginFrame(): void {
    this.builtThisFrame = 0;
  }

  update(id: number, pose: RemotePose, frameSeconds: number): void {
    let d = this.drawn.get(id);
    // (Re)build when the team changes, or to swap the simple soldier for the model.
    const upgrade = d?.simple && this.assets && this.builtThisFrame < 2;
    if (!d || d.team !== pose.team || upgrade) {
      const weapon = d?.weapon ?? null;
      if (d) this.remove(d);
      d = this.build(id, pose.team);
      this.drawn.set(id, d);
      d.weapon = null;
      this.setWeaponOf(d, weapon);
    }
    const flashing = performance.now() < d.flashUntil;
    if (d.rig) {
      d.rig.visible = true;
      const near = d.rig.root.position.distanceTo(this.viewer) < RemotePlayers.detailDistance;
      d.rig.update(pose, frameSeconds, near);
      for (const m of d.rig.model.flashMats) m.emissiveIntensity = flashing ? 1.2 : 0;
      return;
    }
    const r = d.simple!;
    // Death: fall over for 0.5 s, stay down briefly, sink out; respawn resets.
    if (!pose.alive && r.alive) r.deadFor = 0;
    if (pose.alive && !r.alive) r.deadFor = -1;
    r.alive = pose.alive;
    r.root.position.set(...pose.position);
    r.root.rotation.y = pose.yaw;
    if (r.deadFor >= 0) {
      r.deadFor += frameSeconds;
      const fall = Math.min(1, r.deadFor / 0.5);
      r.body.rotation.x = -fall * (Math.PI / 2) * 0.95;
      r.body.position.y = -Math.max(0, r.deadFor - 1.8) * 0.8;
      r.root.visible = r.deadFor < 3;
    } else {
      r.body.rotation.x = 0;
      r.body.position.y = 0;
      r.root.visible = true;
      // Crouch: squash the body (the model is built at standing height).
      r.body.scale.y = pose.crouching ? movement.crouchHeight / movement.standingHeight : 1;
    }
    for (const m of r.flashMats) m.emissiveIntensity = flashing ? 1.6 : 0;
  }

  private build(id: number, team: number): Drawn {
    if (this.assets) {
      try {
        // Body variant from the player id: a mix of men and women on both sides.
        this.builtThisFrame++;
        const model = createSoldierModel(this.assets, team, id % 2);
        model.root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = RemotePlayers.castShadows;
        });
        this.scene.add(model.root);
        return {
          team,
          rig: new SoldierRig(this.assets, model),
          simple: null,
          flashUntil: 0,
          weapon: null,
        };
      } catch (e) {
        console.warn('[soldiers] could not build a model soldier', e);
      }
    }
    const simple = makeSoldier(team);
    this.scene.add(simple.root);
    return { team, rig: null, simple, flashUntil: 0, weapon: null };
  }

  private remove(d: Drawn): void {
    d.rig?.dispose();
    if (d.simple) this.scene.remove(d.simple.root);
  }

  private setWeaponOf(d: Drawn, weapon: WeaponModelId | null): void {
    if (d.weapon === weapon) return;
    d.weapon = weapon;
    d.rig?.setWeapon(weapon);
  }

  /** Which weapon a player holds (from their snapshot). */
  setWeapon(id: number, weaponClass: Weapon['class'] | undefined): void {
    const d = this.drawn.get(id);
    if (d) this.setWeaponOf(d, weaponClass ? MODEL_FOR_CLASS[weaponClass] : null);
  }

  /** A player fired: their weapon kicks. */
  fired(id: number): void {
    this.drawn.get(id)?.rig?.fired();
  }

  /** Where a player's shots leave their gun (for tracers), if their model is drawn. */
  muzzleOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    return this.drawn.get(id)?.rig?.muzzle(out) ?? null;
  }

  /** Hide one player until their next update (killcam: the camera is inside the killer). */
  hide(id: number): void {
    const d = this.drawn.get(id);
    if (d?.rig) d.rig.visible = false;
    if (d?.simple) d.simple.root.visible = false;
  }

  /** Brief white flash: the server confirmed our hit on this player. */
  flash(id: number): void {
    const d = this.drawn.get(id);
    if (d) d.flashUntil = performance.now() + 110;
  }

  /** Positions of drawn remote players (used by end-to-end tests). */
  positions(): number[][] {
    return [...this.drawn.values()].map((d) => {
      const p = (d.rig?.root ?? d.simple!.root).position;
      return [p.x, p.y, p.z];
    });
  }

  /** Above a player's head (for name tags / damage numbers). */
  headOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const d = this.drawn.get(id);
    if (!d) return null;
    if (d.rig) return d.rig.visible ? d.rig.head(out).setY(out.y + 0.32) : null;
    const r = d.simple!;
    if (!r.root.visible) return null;
    return out.copy(r.root.position).setY(r.root.position.y + movement.standingHeight + 0.25);
  }

  /** Remove players that are no longer in snapshots. */
  retain(ids: ReadonlySet<number>): void {
    for (const [id, d] of this.drawn) {
      if (ids.has(id)) continue;
      this.remove(d);
      this.drawn.delete(id);
    }
  }
}

function mat(color: number, rough = 0.6, metal = 0.1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: metal,
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });
}

function box(
  w: number,
  h: number,
  d: number,
  m: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = RemotePlayers.castShadows;
  return mesh;
}

/** An original soldier silhouette, 1.8 m tall, facing -Z. */
function makeSoldier(team: number): Remote {
  const color = TEAM_COLORS[team] ?? 0xcccccc;
  const dark = TEAM_DARK[team] ?? 0x333333;
  const uniform = mat(color, 0.7);
  const vest = mat(dark, 0.5, 0.2);
  const skin = mat(0x2a2d33, 0.8); // gloves/boots, neutral
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0b0d10,
    roughness: 0.15,
    metalness: 0.8,
  });
  const gunMat = new THREE.MeshStandardMaterial({
    color: 0x1f2328,
    roughness: 0.5,
    metalness: 0.4,
  });

  const body = new THREE.Group();
  // Legs and boots
  body.add(box(0.17, 0.78, 0.2, uniform, -0.11, 0.47, 0));
  body.add(box(0.17, 0.78, 0.2, uniform, 0.11, 0.47, 0));
  body.add(box(0.19, 0.12, 0.28, skin, -0.11, 0.06, -0.03));
  body.add(box(0.19, 0.12, 0.28, skin, 0.11, 0.06, -0.03));
  // Torso + armoured vest
  body.add(box(0.44, 0.56, 0.26, uniform, 0, 1.14, 0));
  body.add(box(0.48, 0.42, 0.3, vest, 0, 1.18, 0));
  // Arms reaching forward to the rifle
  const armL = box(0.12, 0.12, 0.46, uniform, -0.2, 1.24, -0.2);
  armL.rotation.x = 0.15;
  const armR = box(0.12, 0.12, 0.46, uniform, 0.2, 1.24, -0.2);
  armR.rotation.x = 0.15;
  body.add(armL, armR);
  body.add(box(0.07, 0.1, 0.7, gunMat, 0.05, 1.26, -0.42));
  // Head: helmet + visor
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), uniform);
  head.position.set(0, 1.62, 0);
  head.castShadow = RemotePlayers.castShadows;
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    vest,
  );
  helmet.position.set(0, 1.64, 0);
  body.add(head, helmet, box(0.26, 0.07, 0.06, visorMat, 0, 1.63, -0.14));

  const root = new THREE.Group();
  root.add(body);
  root.userData.team = team;
  return { root, body, flashMats: [uniform, vest], flashUntil: 0, alive: true, deadFor: -1 };
}
