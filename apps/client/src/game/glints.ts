import * as THREE from 'three/webgpu';
import type { RemotePose } from '@sentinel/shared';

const MAX = 11;
const toMe = new THREE.Vector3();
const aim = new THREE.Vector3();

/**
 * Scope glint: an enemy fully aimed through a scope flashes a bright star at their scope,
 * strongest when they point it at you (sun on the lens), so a sniper watching a lane gives
 * themselves away. The server says who is scoped (snapshot flag); where they look is their
 * snapshot yaw/pitch. A fixed set of sprites, all in the scene from the start (no compile
 * stall when the first one shows).
 */
export class Glints {
  private readonly sprites: THREE.Sprite[] = [];
  private used = 0;

  constructor(scene: THREE.Scene) {
    const map = starTexture();
    for (let i = 0; i < MAX; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map,
          color: new THREE.Color(1, 0.95, 0.8).multiplyScalar(4),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        }),
      );
      s.frustumCulled = false;
      s.position.set(0, -500, 0);
      scene.add(s);
      this.sprites.push(s);
    }
  }

  begin(): void {
    this.used = 0;
  }

  /** A scoped enemy with their scope at `lens`: a glint facing `camera`. */
  add(pose: RemotePose, lens: THREE.Vector3, camera: THREE.Vector3, time: number): void {
    const s = this.sprites[this.used];
    if (!s) return;
    toMe.subVectors(camera, lens);
    const dist = toMe.length();
    if (dist < 4) return; // up close it's just a soldier aiming at you
    toMe.divideScalar(dist);
    const cp = Math.cos(pose.pitch);
    aim.set(-Math.sin(pose.yaw) * cp, Math.sin(pose.pitch), -Math.cos(pose.yaw) * cp);
    const facing = aim.dot(toMe);
    const strength = THREE.MathUtils.smoothstep(facing, 0.82, 0.98);
    if (strength <= 0) return;
    this.used++;
    s.position.copy(lens);
    // Same size on screen at any distance (a clear flare, ~3° across), twinkling.
    s.scale.setScalar(Math.max(0.3, dist * 0.06));
    s.material.opacity = strength * (0.75 + 0.25 * Math.sin(time * 23 + dist));
    s.material.rotation = time * 0.6;
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      if (s.material.opacity !== 0) s.material.opacity = 0;
    }
  }
}

/** A four-pointed star with a hot centre, drawn once. */
function starTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const mid = size / 2;
  const core = g.createRadialGradient(mid, mid, 0, mid, mid, mid * 0.45);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, size, size);
  for (const [w, h] of [
    [size, 3],
    [3, size],
  ] as const) {
    const ray = g.createLinearGradient(mid - w / 2, mid - h / 2, mid + w / 2, mid + h / 2);
    ray.addColorStop(0, 'rgba(255,255,255,0)');
    ray.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    ray.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = ray;
    g.fillRect(mid - w / 2, mid - h / 2, w, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
