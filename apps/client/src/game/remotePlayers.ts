import * as THREE from 'three/webgpu';
import { soldierMaterial } from './soldier/rim.ts';
import { movement } from '@sentinel/content';
import type { RemotePose } from '@sentinel/shared';
import type { Weapon } from '@sentinel/content';
import { createSoldierModel, loadSoldierAssets, type SoldierAssets } from './soldier/assets.ts';
import { modelFor, WEAPON_MODEL_IDS, type WeaponModelId } from './soldier/holds.ts';

const WEAPON_MODELS: readonly WeaponModelId[] = WEAPON_MODEL_IDS;
import { SoldierRig } from './soldier/rig.ts';

/** Faction colours from docs/GAME_DESIGN.md: Aegis Directive blue, Ember Syndicate orange. */
const TEAM_COLORS = [0x2f7bff, 0xff7a1f];
const TEAM_DARK = [0x1b3566, 0x6b3310];

interface Remote {
  root: THREE.Group;
  body: THREE.Group;
  /** Materials that flash when this player is hit. */
  flashMats: FlashMaterial[];
  flashUntil: number;
  alive: boolean;
  /** Seconds since death (drives the fall), -1 while alive. */
  deadFor: number;
}

/** A drawn player: the animated soldier model, or the simple shape soldier until it loads. */
interface Drawn {
  /**
   * When they left the snapshots (performance.now()), or -1 while present. Out of sight,
   * a soldier is only hidden: rebuilding one (skinned model, rig, materials) each time an
   * enemy steps back into view caused hitches in firefights.
   */
  goneSince: number;
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
/** A soldier out of the snapshots this long has left the match: free it. */
const GONE_FREE_MS = 30_000;

export class RemotePlayers {
  /** Soldiers cast shadows only where shadows are redrawn every frame (High). */
  static castShadows = true;

  private drawn = new Map<number, Drawn>();
  private assets: SoldierAssets | null = null;

  /** Settles when the soldier models are loaded and compiled (or failed: simple soldiers). */
  readonly ready: Promise<unknown>;

  /** Model soldiers built this frame (swapping 11 at once would be one long frame). */
  private builtThisFrame = 0;

  constructor(
    private readonly scene: THREE.Scene,
    renderer?: THREE.WebGPURenderer,
    camera?: THREE.Camera,
  ) {
    const t0 = performance.now();
    let loaded = 0;
    this.ready = loadSoldierAssets()
      .then((a) => {
        loaded = performance.now();
        return this.warm(a, renderer, camera);
      })
      .then((a) => {
        this.assets = a;
        const now = performance.now();
        console.info(
          `[soldiers] models ready: loaded in ${Math.round(loaded - t0)} ms, prepared in ${Math.round(now - loaded)} ms`,
        );
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // Automated tests ask for simple soldiers on purpose: not worth a warning.
        if (msg.includes('automated test')) console.info('[soldiers] simple shapes (test)');
        else console.warn('[soldiers] models unavailable, using simple shapes', e);
      });
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
      // At most 3 s: a hidden tab can stall this, and the models must not wait for it.
      await Promise.race([
        renderer.compileAsync(group, camera, this.scene).catch(() => undefined),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
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
    (d.rig?.root ?? d.simple!.root).matrixWorldAutoUpdate = true;
    const flashing = performance.now() < d.flashUntil;
    if (d.rig) {
      d.rig.visible = true;
      d.rig.update(pose, frameSeconds);
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
    } else if (pose.prone) {
      // Lying down: tipped forward flat, centred on the feet point (like the prone hitboxes).
      r.body.rotation.x = -Math.PI / 2;
      r.body.position.set(0, 0.15, 0.9);
      r.body.scale.y = 1;
      r.root.visible = true;
    } else {
      r.body.rotation.x = 0;
      r.body.position.set(0, 0, 0);
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
          goneSince: -1,
        };
      } catch (e) {
        console.warn('[soldiers] could not build a model soldier', e);
      }
    }
    const simple = makeSoldier(team);
    this.scene.add(simple.root);
    return { team, rig: null, simple, flashUntil: 0, weapon: null, goneSince: -1 };
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
  setWeapon(id: number, weapon: Pick<Weapon, 'id' | 'class'> | undefined): void {
    const d = this.drawn.get(id);
    if (d) this.setWeaponOf(d, weapon ? modelFor(weapon) : null);
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
    return [...this.drawn.values()]
      .filter((d) => d.goneSince < 0)
      .map((d) => {
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

  /**
   * Players no longer in snapshots (out of sight, ADR 0009) are hidden and kept, ready for
   * when they reappear; only after a long absence (left the match) is the soldier freed.
   */
  retain(ids: ReadonlySet<number>, now = performance.now()): void {
    for (const [id, d] of this.drawn) {
      if (ids.has(id)) {
        d.goneSince = -1;
        continue;
      }
      if (d.goneSince < 0) {
        d.goneSince = now;
        if (d.rig) d.rig.visible = false;
        if (d.simple) d.simple.root.visible = false;
        // Hidden soldiers skip the per-frame matrix update of their whole skeleton.
        (d.rig?.root ?? d.simple!.root).matrixWorldAutoUpdate = false;
      } else if (now - d.goneSince > GONE_FREE_MS) {
        this.remove(d);
        this.drawn.delete(id);
      }
    }
  }
}

/** A soldier material whose emissive the hit flash turns up. */
type FlashMaterial = { emissiveIntensity: number };

function mat(
  team: number,
  color: number,
  rough = 0.6,
  metal = 0.1,
): THREE.MeshStandardNodeMaterial {
  return soldierMaterial(team, {
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
  const uniform = mat(team, color, 0.7);
  const vest = mat(team, dark, 0.5, 0.2);
  const skin = mat(team, 0x2a2d33, 0.8); // gloves/boots, neutral
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
