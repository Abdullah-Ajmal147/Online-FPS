import * as THREE from 'three/webgpu';

/**
 * A fixed set of reusable objects, all in the scene from the start, shown when used. The
 * renderer prepares an object's material and pipeline the first time it draws it; creating
 * new materials during play (dozens per second in a firefight) caused 100–300 ms hitches.
 * Pooled objects are drawn once while loading (see `warm`) and never created or freed again.
 */
class Pool<T extends THREE.Object3D> {
  private readonly items: { obj: T; age: number; life: number; active: boolean }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, count: number, make: () => T) {
    for (let i = 0; i < count; i++) {
      const obj = make();
      obj.visible = false;
      obj.frustumCulled = false;
      scene.add(obj);
      this.items.push({ obj, age: 0, life: 0, active: false });
    }
  }

  /** A free object, or the oldest one when all are busy (its effect just ends early). */
  take(life: number): T {
    const it = this.items[this.next]!;
    this.next = (this.next + 1) % this.items.length;
    it.age = 0;
    it.life = life;
    it.active = true;
    it.obj.visible = true;
    it.obj.scale.setScalar(1);
    return it.obj;
  }

  /** Age everything; `each` gets 0→1 over the life; finished objects are hidden. */
  update(frame: number, each: (obj: T, k: number) => void): void {
    for (const it of this.items) {
      if (!it.active) continue;
      it.age += frame;
      if (it.age >= it.life) {
        it.active = false;
        it.obj.visible = false;
        continue;
      }
      each(it.obj, it.age / it.life);
    }
  }

  /** Show every object for one frame (far below the map) so the renderer prepares them now. */
  warm(show: boolean): void {
    for (const it of this.items) {
      if (it.active) continue;
      it.obj.visible = show;
      if (show) it.obj.position.set(0, -500, 0);
    }
  }
}

type Faded = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

/** Short-lived shot effects in the world: tracers, remote muzzle flashes, impact marks. */
export class Effects {
  private readonly raycaster = new THREE.Raycaster();
  private readonly tracers: Pool<THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>;
  private readonly flashes: Pool<Faded>;
  private readonly impacts: Pool<Faded>;
  private readonly blasts: Pool<Faded>;
  private readonly dust: Pool<Faded>;
  private readonly scorches: Pool<Faded>;
  private warmFrames = 2;

  /** What shots can hit visually (the map meshes); set when a map loads. */
  private solids: THREE.Object3D = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.raycaster.far = 150;
    const flashGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const markGeo = new THREE.CircleGeometry(0.05, 10);
    const mesh = (geo: THREE.BufferGeometry, color: number, opacity: number, depthWrite = true) =>
      new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite }),
      ) as Faded;
    this.tracers = new Pool(scene, 48, () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      return new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.8 }),
      );
    });
    this.flashes = new Pool(scene, 24, () => mesh(flashGeo, 0xffd27a, 1));
    this.impacts = new Pool(scene, 96, () => mesh(markGeo, 0x15171a, 0.85, false));
    this.blasts = new Pool(scene, 4, () => mesh(flashGeo, 0xffb347, 1));
    this.dust = new Pool(scene, 4, () => mesh(flashGeo, 0x5b5048, 0.7, false));
    this.scorches = new Pool(scene, 12, () => {
      const m = mesh(markGeo, 0x111111, 0.7, false);
      m.rotation.x = -Math.PI / 2;
      return m;
    });
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
    const line = this.tracers.take(0.06);
    line.position.set(0, 0, 0);
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  muzzleFlash(at: THREE.Vector3): void {
    this.flashes.take(0.05).position.copy(at);
  }

  impact(hit: THREE.Intersection): void {
    if (!hit.face) return;
    const m = this.impacts.take(8);
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    m.position.copy(hit.point).addScaledVector(normal, 0.01);
    m.lookAt(m.position.clone().add(normal));
  }

  /** Frag blast: a bright flash ball that swells and fades, plus a scorch mark below. */
  explosion(at: THREE.Vector3): void {
    this.blasts
      .take(0.35)
      .position.copy(at)
      .setY(at.y + 0.4);
    this.dust
      .take(1.4)
      .position.copy(at)
      .setY(at.y + 0.6);
    const down = this.castMap(at.clone().setY(at.y + 0.3), new THREE.Vector3(0, -1, 0), 2);
    if (down?.face) {
      const s = this.scorches.take(12);
      s.scale.setScalar(20);
      s.position.copy(down.point).setY(down.point.y + 0.012);
    }
  }

  update(frame: number): void {
    // First frames after loading: draw every pooled object once, out of sight.
    if (this.warmFrames > 0) {
      const show = --this.warmFrames > 0;
      for (const p of this.pools()) p.warm(show);
    }
    const fade = (base: number) => (o: Faded, k: number) => (o.material.opacity = base * (1 - k));
    this.tracers.update(frame, (o, k) => (o.material.opacity = 0.8 * (1 - k)));
    this.flashes.update(frame, fade(1));
    this.impacts.update(frame, fade(0.85));
    this.scorches.update(frame, fade(0.7));
    // Blast and dust swell (0.06 m sphere → ~3 m / ~2 m across) while fading.
    this.blasts.update(frame, (o, k) => {
      o.scale.setScalar(1 + 44 * Math.min(1, k * 2.5));
      o.material.opacity = 1 - k;
    });
    this.dust.update(frame, (o, k) => {
      o.scale.setScalar(1 + 29 * Math.min(1, k * 2.5));
      o.material.opacity = 0.7 * (1 - k);
    });
  }

  private pools(): Pool<THREE.Object3D>[] {
    return [this.tracers, this.flashes, this.impacts, this.blasts, this.dust, this.scorches];
  }
}
