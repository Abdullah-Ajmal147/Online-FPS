import type { GameMap } from '@sentinel/content';
import * as THREE from 'three/webgpu';

const NEUTRAL = 0xd9dde0;
const TEAM = [0x4aa3ff, 0xff6b35];

/**
 * Domination points in the world: a ring on the ground (the capture radius) and a tall,
 * faint beam so points can be found from anywhere. Coloured by who holds them.
 */
export class PointMarkers {
  private readonly group = new THREE.Group();
  private readonly byId = new Map<
    string,
    { ring: THREE.MeshBasicMaterial; beam: THREE.MeshBasicMaterial }
  >();

  constructor(private readonly scene: THREE.Scene) {
    this.group.visible = false;
    scene.add(this.group);
  }

  /** New map: markers at its points (radius from the mode's rules). */
  setMap(map: GameMap, radius: number): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    this.byId.clear();
    for (const p of map.points) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: NEUTRAL,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.25, radius, 48), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.position[0], p.position[1] + 0.03, p.position[2]);
      const beamMat = new THREE.MeshBasicMaterial({
        color: NEUTRAL,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 30, 12, 1, true), beamMat);
      beam.position.set(p.position[0], p.position[1] + 15, p.position[2]);
      this.group.add(ring, beam);
      this.byId.set(p.id, { ring: ringMat, beam: beamMat });
    }
  }

  /** From match info: show only in objective modes, colour by holder. */
  update(points: readonly { id: string; owner: number }[]): void {
    this.group.visible = points.length > 0;
    for (const p of points) {
      const m = this.byId.get(p.id);
      if (!m) continue;
      const color = p.owner < 0 ? NEUTRAL : TEAM[p.owner]!;
      m.ring.color.setHex(color);
      m.beam.color.setHex(color);
    }
  }
}
