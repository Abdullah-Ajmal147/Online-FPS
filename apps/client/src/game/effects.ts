import * as THREE from 'three/webgpu';

interface Timed {
  obj: THREE.Object3D;
  age: number;
  life: number;
  fade?: THREE.Material & { opacity: number };
}

/** Short-lived shot effects in the world: tracers, remote muzzle flashes, impact marks. */
export class Effects {
  private items: Timed[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly tracerMat = new THREE.LineBasicMaterial({
    color: 0xfff0b0,
    transparent: true,
    opacity: 0.8,
  });
  private readonly flashGeo = new THREE.SphereGeometry(0.06, 8, 6);
  private readonly impactGeo = new THREE.CircleGeometry(0.05, 10);

  /** What shots can hit visually (the map meshes); set when a map loads. */
  private solids: THREE.Object3D = new THREE.Group();

  constructor(private readonly scene: THREE.Scene) {
    this.raycaster.far = 150;
  }

  setSolids(solids: THREE.Object3D): void {
    this.solids = solids;
  }

  /** Where a ray hits the map (visual only; the server decides real hits). */
  castMap(origin: THREE.Vector3, dir: THREE.Vector3, max = 150): THREE.Intersection | null {
    this.raycaster.set(origin, dir);
    this.raycaster.far = max;
    return this.raycaster.intersectObject(this.solids, true)[0] ?? null;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = this.tracerMat.clone();
    const line = new THREE.Line(geo, mat);
    this.add(line, 0.06, mat);
  }

  muzzleFlash(at: THREE.Vector3): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 1 });
    const m = new THREE.Mesh(this.flashGeo, mat);
    m.position.copy(at);
    this.add(m, 0.05, mat);
  }

  impact(hit: THREE.Intersection): void {
    if (!hit.face) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x15171a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const m = new THREE.Mesh(this.impactGeo, mat);
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    m.position.copy(hit.point).addScaledVector(normal, 0.01);
    m.lookAt(m.position.clone().add(normal));
    this.add(m, 8, mat);
  }

  update(frame: number): void {
    this.items = this.items.filter((it) => {
      it.age += frame;
      if (it.fade) it.fade.opacity = Math.max(0, 1 - it.age / it.life);
      if (it.age < it.life) return true;
      this.scene.remove(it.obj);
      if (it.obj instanceof THREE.Line) it.obj.geometry.dispose();
      it.fade?.dispose();
      return false;
    });
  }

  private add(
    obj: THREE.Object3D,
    life: number,
    fade?: THREE.Material & { opacity: number },
  ): void {
    this.scene.add(obj);
    this.items.push({ obj, age: 0, life, ...(fade ? { fade } : {}) });
    if (this.items.length > 200) {
      const old = this.items.shift()!;
      this.scene.remove(old.obj);
    }
  }
}
