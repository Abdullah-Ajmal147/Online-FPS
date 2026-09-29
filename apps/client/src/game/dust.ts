import * as THREE from 'three/webgpu';

/** Motes around the camera, the box they live in (m), and how fast they drift (m/s). */
const COUNT = 240;
const BOX = 12;
const DRIFT = 0.12;

/**
 * Dust in the air: tiny bright specks drifting slowly around the player, catching the light
 * like dust in sunlight (Medium/High). They live in a box that follows the camera; a mote that
 * leaves one side comes back in the other, so there are always some close by. One instanced
 * draw call; per frame only their matrices change.
 */
export class Dust {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly vel = new Float32Array(COUNT * 3);
  private readonly phase = new Float32Array(COUNT);
  private readonly m = new THREE.Matrix4();
  private time = 0;

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 0.94, 0.82).multiplyScalar(1.4),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.0055, 0), material, COUNT);
    this.mesh.frustumCulled = false;
    // Visible from the start, so the world-ready compile includes it (no stall on first show).
    for (let i = 0; i < COUNT; i++) {
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] = (Math.random() - 0.5) * BOX;
        this.vel[i * 3 + k] = (Math.random() - 0.5) * DRIFT;
      }
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! * 0.4 - 0.01; // mostly sideways, settling
      this.phase[i] = Math.random() * Math.PI * 2;
    }
    scene.add(this.mesh);
  }

  update(frame: number, camera: THREE.Vector3, on: boolean): void {
    this.mesh.visible = on;
    if (!on) return;
    this.time += frame;
    const half = BOX / 2;
    for (let i = 0; i < COUNT; i++) {
      const j = i * 3;
      // A slow swirl on top of each mote's drift.
      const swirl = Math.sin(this.time * 0.7 + this.phase[i]!) * 0.05;
      let x = this.pos[j]! + (this.vel[j]! + swirl) * frame;
      let y = this.pos[j + 1]! + this.vel[j + 1]! * frame;
      let z = this.pos[j + 2]! + (this.vel[j + 2]! - swirl) * frame;
      // Kept relative to the camera: wrap into the box around it.
      x = wrap(x, camera.x, half);
      y = wrap(y, camera.y, half * 0.5);
      z = wrap(z, camera.z, half);
      this.pos[j] = x;
      this.pos[j + 1] = y;
      this.pos[j + 2] = z;
      this.m.makeTranslation(x, y, z);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** `v` moved by whole box widths so it lies within `half` of `centre`. */
function wrap(v: number, centre: number, half: number): number {
  const size = half * 2;
  const d = v - centre;
  if (d > half) return v - size * Math.ceil((d - half) / size);
  if (d < -half) return v + size * Math.ceil((-half - d) / size);
  return v;
}
