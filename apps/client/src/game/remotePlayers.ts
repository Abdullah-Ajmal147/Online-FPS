import * as THREE from 'three/webgpu';
import { movement } from '@sentinel/content';
import type { RemotePose } from '../net/interpolator.ts';

/** Faction colours from docs/GAME_DESIGN.md: Aegis Directive blue, Ember Syndicate orange. */
const TEAM_COLORS = [0x2f81f7, 0xf0883e];

/** Greybox stand-in for other players: a team-coloured capsule with a visor showing where they face. */
export class RemotePlayers {
  private meshes = new Map<number, THREE.Group>();

  constructor(private readonly scene: THREE.Scene) {}

  update(id: number, pose: RemotePose): void {
    let group = this.meshes.get(id);
    if (!group) {
      group = makePlayer(pose.team);
      this.meshes.set(id, group);
      this.scene.add(group);
    }
    group.position.set(...pose.position);
    group.rotation.y = pose.yaw;
    group.scale.y = pose.crouching ? movement.crouchHeight / movement.standingHeight : 1;
  }

  /** Positions of drawn remote players (used by end-to-end tests). */
  positions(): number[][] {
    return [...this.meshes.values()].map((g) => [g.position.x, g.position.y, g.position.z]);
  }

  /** Remove players that are no longer in snapshots. */
  retain(ids: ReadonlySet<number>): void {
    for (const [id, group] of this.meshes) {
      if (ids.has(id)) continue;
      this.scene.remove(group);
      this.meshes.delete(id);
    }
  }
}

function makePlayer(team: number): THREE.Group {
  const { capsuleRadius: r, standingHeight: h } = movement;
  const color = TEAM_COLORS[team] ?? 0xcccccc;
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(r, h - 2 * r, 6, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  body.position.y = h / 2;
  body.castShadow = true;
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(r * 1.2, 0.12, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.3 }),
  );
  visor.position.set(0, h - 0.25, -r); // faces -Z, like yaw 0
  group.add(body, visor);
  return group;
}
