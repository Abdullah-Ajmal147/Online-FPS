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
  /** Impact puffs (soft sprites that swell and fade) and sparks (tiny, flying, falling). */
  private readonly puffs: Pool<THREE.Sprite>;
  private readonly sparks: Pool<Faded>;
  /** Our own spent cases, flying out of the gun. */
  private readonly casings: Pool<THREE.Mesh>;
  /**
   * One light that flashes at the muzzle when a shot is fired (walls, hands and the gun light
   * up). In the scene (Medium/High) with intensity 0 in between: adding and removing lights
   * rebuilds every material's shader, so it only changes with the graphics preset. Low leaves
   * it out: a point light costs on every lit pixel, even when dark.
   */
  private readonly muzzleLightSource = new THREE.PointLight(0xffc27a, 0, 9, 1.6);
  private readonly scene: THREE.Scene;
  private muzzleLightAge = Infinity;
  private readonly gravity = new THREE.Vector3(0, -9.8, 0);
  private warmFrames = 2;

  /** What shots can hit visually (the map meshes); set when a map loads. */
  private solids: THREE.Object3D = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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
    const puffMap = softDisc();
    this.puffs = new Pool(scene, 32, () => {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: puffMap,
          color: 0xb3a592,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
        }),
      );
      s.userData.v = new THREE.Vector3();
      return s;
    });
    const sparkGeo = new THREE.SphereGeometry(0.012, 4, 3);
    this.sparks = new Pool(scene, 64, () => {
      const m = mesh(sparkGeo, 0xffd58a, 1, false);
      m.userData.v = new THREE.Vector3();
      return m;
    });
    const caseGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.026, 6);
    caseGeo.rotateZ(Math.PI / 2);
    const brass = new THREE.MeshStandardMaterial({
      color: 0xb8903e,
      metalness: 0.9,
      roughness: 0.3,
    });
    this.casings = new Pool(scene, 24, () => {
      const m = new THREE.Mesh(caseGeo, brass);
      m.userData.v = new THREE.Vector3();
      m.userData.spin = new THREE.Vector3();
      return m;
    });
  }

  /** Muzzle light on (Medium/High) or out of the scene (Low). */
  setMuzzleLight(on: boolean): void {
    if (on === (this.muzzleLightSource.parent !== null)) return;
    if (on) this.scene.add(this.muzzleLightSource);
    else this.muzzleLightSource.removeFromParent();
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
    this.muzzleLight(at);
  }

  /** Light up the surroundings for a moment (every shot, ours and others'). */
  muzzleLight(at: THREE.Vector3): void {
    this.muzzleLightSource.position.copy(at);
    this.muzzleLightAge = 0;
  }

  /**
   * A bullet hitting the map: a hole, a puff of dust off the surface, and a few sparks.
   * `sparks`: more of them (metal surfaces).
   */
  impact(hit: THREE.Intersection, sparks = 3): void {
    if (!hit.face) return;
    const m = this.impacts.take(10);
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    m.position.copy(hit.point).addScaledVector(normal, 0.01);
    m.lookAt(m.position.clone().add(normal));
    const puff = this.puffs.take(0.7);
    puff.position.copy(hit.point).addScaledVector(normal, 0.08);
    (puff.userData.v as THREE.Vector3).copy(normal).multiplyScalar(0.6).y += 0.25;
    for (let i = 0; i < sparks; i++) {
      const s = this.sparks.take(0.18 + Math.random() * 0.15);
      s.position.copy(hit.point).addScaledVector(normal, 0.02);
      (s.userData.v as THREE.Vector3)
        .set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5)
        .multiplyScalar(4)
        .addScaledVector(normal, 3.5);
    }
  }

  /** A spent case out of our gun: `at` the ejection port, flung along `right` and up. */
  casing(at: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): void {
    const c = this.casings.take(0.9);
    c.position.copy(at);
    (c.userData.v as THREE.Vector3)
      .copy(right)
      .multiplyScalar(1.6 + Math.random() * 0.6)
      .addScaledVector(up, 1.4 + Math.random() * 0.5);
    (c.userData.spin as THREE.Vector3).set(Math.random() * 30, Math.random() * 30, 20);
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
    this.puffs.update(frame, (o, k) => {
      o.position.addScaledVector(o.userData.v as THREE.Vector3, frame);
      o.scale.setScalar(0.16 + 0.75 * Math.sqrt(k));
      o.material.opacity = 0.62 * (1 - k);
    });
    this.sparks.update(frame, (o, k) => {
      const v = o.userData.v as THREE.Vector3;
      v.addScaledVector(this.gravity, frame);
      o.position.addScaledVector(v, frame);
      o.material.opacity = 1 - k;
    });
    this.casings.update(frame, (o) => {
      const v = o.userData.v as THREE.Vector3;
      v.addScaledVector(this.gravity, frame);
      o.position.addScaledVector(v, frame);
      const spin = o.userData.spin as THREE.Vector3;
      o.rotation.x += spin.x * frame;
      o.rotation.y += spin.y * frame;
      o.rotation.z += spin.z * frame;
    });
    // Muzzle light: bright for a frame or two, gone in 60 ms.
    this.muzzleLightAge += frame;
    this.muzzleLightSource.intensity =
      this.muzzleLightAge < 0.06 ? 14 * (1 - this.muzzleLightAge / 0.06) : 0;
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
    return [
      this.tracers,
      this.flashes,
      this.impacts,
      this.blasts,
      this.dust,
      this.scorches,
      this.puffs,
      this.sparks,
      this.casings,
    ] as Pool<THREE.Object3D>[];
  }
}

/** A soft round sprite texture (white centre fading to clear), drawn once. */
function softDisc(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
