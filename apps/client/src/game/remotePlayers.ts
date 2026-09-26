import * as THREE from 'three/webgpu';
import { movement } from '@sentinel/content';
import type { RemotePose } from '@sentinel/shared';

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

/**
 * Other players, drawn as simple original soldiers built from shapes (real models arrive with
 * the content pipeline): helmet with visor, vest, arms holding a rifle, legs. Team colours stay
 * bright for readability. Hit → white flash; death → topple over and sink away.
 */
export class RemotePlayers {
  private remotes = new Map<number, Remote>();

  constructor(private readonly scene: THREE.Scene) {}

  update(id: number, pose: RemotePose, frameSeconds: number): void {
    let r = this.remotes.get(id);
    if (!r || r.root.userData.team !== pose.team) {
      if (r) this.scene.remove(r.root);
      r = makeSoldier(pose.team);
      this.remotes.set(id, r);
      this.scene.add(r.root);
    }
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

    const flashing = performance.now() < r.flashUntil;
    for (const m of r.flashMats) m.emissiveIntensity = flashing ? 1.6 : 0;
  }

  /** Brief white flash: the server confirmed our hit on this player. */
  flash(id: number): void {
    const r = this.remotes.get(id);
    if (r) r.flashUntil = performance.now() + 110;
  }

  /** Positions of drawn remote players (used by end-to-end tests). */
  positions(): number[][] {
    return [...this.remotes.values()].map((r) => [
      r.root.position.x,
      r.root.position.y,
      r.root.position.z,
    ]);
  }

  /** Head position of a player (for name tags / damage numbers). */
  headOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    if (!r || !r.root.visible) return null;
    return out.copy(r.root.position).setY(r.root.position.y + movement.standingHeight + 0.25);
  }

  /** Remove players that are no longer in snapshots. */
  retain(ids: ReadonlySet<number>): void {
    for (const [id, r] of this.remotes) {
      if (ids.has(id)) continue;
      this.scene.remove(r.root);
      this.remotes.delete(id);
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
  mesh.castShadow = true;
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
  head.castShadow = true;
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
