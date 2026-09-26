import * as THREE from 'three/webgpu';

interface Floater {
  el: HTMLDivElement;
  world: THREE.Vector3;
  age: number;
}

/**
 * Screen-space feedback that follows 3D positions: floating damage numbers and teammate
 * name tags. Plain DOM (absolutely positioned) updated each frame — cheaper than re-rendering
 * the Preact HUD 60 times a second.
 */
export class Feedback {
  private readonly layer: HTMLDivElement;
  private floaters: Floater[] = [];
  private tags = new Map<number, HTMLDivElement>();
  private readonly tmp = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'feedback-layer';
    host.appendChild(this.layer);
  }

  /** A damage number rising from `world` (yellow for headshots, red on the killing hit). */
  damage(world: THREE.Vector3, amount: number, kind: 'hit' | 'head' | 'kill'): void {
    const el = document.createElement('div');
    el.className = `dmg dmg-${kind}`;
    el.textContent = String(amount);
    this.layer.appendChild(el);
    // Small random offset so several numbers in a burst don't stack on one spot.
    const w = world
      .clone()
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.4, Math.random() * 0.2, 0));
    this.floaters.push({ el, world: w, age: 0 });
  }

  /** Name tags for teammates: id → head position (null hides it). */
  setTags(
    camera: THREE.Camera,
    tags: Map<number, { name: string; head: THREE.Vector3 | null }>,
  ): void {
    for (const [id, el] of this.tags) {
      if (!tags.has(id)) {
        el.remove();
        this.tags.delete(id);
      }
    }
    for (const [id, t] of tags) {
      let el = this.tags.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'nametag';
        this.layer.appendChild(el);
        this.tags.set(id, el);
      }
      if (el.textContent !== t.name) el.textContent = t.name;
      this.place(el, t.head, camera);
    }
  }

  update(camera: THREE.Camera, frameSeconds: number): void {
    this.floaters = this.floaters.filter((f) => {
      f.age += frameSeconds;
      if (f.age > 0.9) {
        f.el.remove();
        return false;
      }
      this.tmp.copy(f.world).setY(f.world.y + f.age * 0.9);
      this.place(f.el, this.tmp, camera);
      f.el.style.opacity = String(Math.min(1, 2.2 * (1 - f.age / 0.9)));
      return true;
    });
  }

  private place(el: HTMLElement, world: THREE.Vector3 | null, camera: THREE.Camera): void {
    if (!world) {
      el.style.display = 'none';
      return;
    }
    const p = this.tmp.copy(world).project(camera);
    if (p.z > 1 || p.z < -1) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.transform = `translate(${((p.x + 1) / 2) * window.innerWidth}px, ${((1 - p.y) / 2) * window.innerHeight}px) translate(-50%, -100%)`;
  }
}
