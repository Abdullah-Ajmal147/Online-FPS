import * as THREE from 'three/webgpu';
import { IMPACT, type SurfaceKind } from './surfaceKinds.ts';

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
      // Idle pool objects skip the per-frame world-matrix update (hundreds of them).
      obj.matrixWorldAutoUpdate = false;
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
    it.obj.matrixWorldAutoUpdate = true;
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
        it.obj.matrixWorldAutoUpdate = false;
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
      it.obj.matrixWorldAutoUpdate = show;
      if (show) it.obj.position.set(0, -500, 0);
    }
  }
}

type Faded = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

const FORWARD = new THREE.Vector3(0, 0, 1);
const tmp = new THREE.Vector3();
/** Bullet marks kept on the map at once, and how long each stays (seconds). */
const MARKS = 200;
const MARK_SECONDS = 40;

/** A ray's hit on the map: distance along the ray, the point and the surface normal. */
export interface MapHit {
  /** What was hit (dust, chips, sparks, the mark, the sound). */
  surface: SurfaceKind;
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}
export type MapRaycast = (origin: THREE.Vector3, dir: THREE.Vector3, max: number) => MapHit | null;

/** Short-lived shot effects in the world: tracers, remote muzzle flashes, impact marks. */
export class Effects {
  private raycast: MapRaycast | null = null;
  private readonly tracers: Pool<Faded>;
  private readonly flashes: Pool<Faded>;
  /** Bullet marks: up to MARKS on the map, the oldest reused first. */
  private readonly impacts: Pool<Faded>;
  /** Chips and splinters knocked off concrete, brick and wood. */
  private readonly chips: Pool<Faded>;
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

  /** `muzzleLight`: start with the light in the scene (Medium/High), so the materials are
   * compiled with it from the first frame; adding it later recompiles every material. */
  constructor(scene: THREE.Scene, muzzleLight = false) {
    this.scene = scene;
    const flashGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const markGeo = new THREE.CircleGeometry(0.05, 10);
    const mesh = (geo: THREE.BufferGeometry, color: number, opacity: number, depthWrite = true) =>
      new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite }),
      ) as Faded;
    // A tracer: a thin glowing rod, 1 m long along +Z (scaled to the streak's length), bright
    // enough to catch the bloom on High.
    const rodGeo = new THREE.CylinderGeometry(0.009, 0.009, 1, 5, 1, true);
    rodGeo.rotateX(Math.PI / 2);
    this.tracers = new Pool(scene, 48, () => {
      const m = new THREE.Mesh(
        rodGeo,
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xffd08a).multiplyScalar(3),
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ) as Faded;
      m.userData = { from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, life: 0 };
      return m;
    });
    this.flashes = new Pool(scene, 24, () => mesh(flashGeo, 0xffd27a, 1));
    const holeMap = bulletHole();
    const holeGeo = new THREE.PlaneGeometry(0.11, 0.11);
    this.impacts = new Pool(scene, MARKS, () => {
      const m = new THREE.Mesh(
        holeGeo,
        new THREE.MeshBasicMaterial({
          map: holeMap,
          transparent: true,
          depthWrite: false,
          // Drawn onto the wall, not in front of it: no fighting with the surface.
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      ) as Faded;
      return m;
    });
    const chipGeo = new THREE.BoxGeometry(0.018, 0.012, 0.03);
    this.chips = new Pool(scene, 64, () => {
      const m = mesh(chipGeo, 0x888888, 1, true);
      m.material.transparent = false;
      m.userData.v = new THREE.Vector3();
      m.userData.spin = new THREE.Vector3();
      return m;
    });
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
    if (muzzleLight) scene.add(this.muzzleLightSource);
    this.casings = new Pool(scene, 24, () => {
      const m = new THREE.Mesh(caseGeo, brass);
      m.userData.v = new THREE.Vector3();
      m.userData.spin = new THREE.Vector3();
      return m;
    });
  }

  /**
   * Show (or hide again) every idle pooled object far below the map, so an async compile of
   * the scene includes them (hidden objects are skipped).
   */
  showPoolsForCompile(show: boolean): void {
    for (const p of this.pools()) p.warm(show);
  }

  /** Muzzle light on (Medium/High) or out of the scene (Low). */
  setMuzzleLight(on: boolean): void {
    if (on === (this.muzzleLightSource.parent !== null)) return;
    if (on) this.scene.add(this.muzzleLightSource);
    else this.muzzleLightSource.removeFromParent();
  }

  /**
   * How rays hit the map, set when a map loads: the physics world's ray cast (its spatial
   * index answers in microseconds). The Three.js raycaster tested every map triangle, and ran
   * every frame (crosshair) and for every shot of every player.
   */
  setRaycast(raycast: MapRaycast): void {
    this.raycast = raycast;
  }

  /**
   * Where a ray hits the map (visual only; the server decides real hits). The result is
   * reused by the next call: use it straight away.
   */
  castMap(origin: THREE.Vector3, dir: THREE.Vector3, max = 150): MapHit | null {
    return this.raycast?.(origin, dir, max) ?? null;
  }

  /** Tracer speed (m/s) and streak length (m): feel.json, live from the tuning panel. */
  tracerSpeed = 420;
  tracerLength = 3.5;

  /** A tracer round: a short bright streak that flies from the muzzle to where it hit. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const dist = from.distanceTo(to);
    if (dist < 0.3) return;
    const life = dist / this.tracerSpeed + this.tracerLength / this.tracerSpeed;
    const m = this.tracers.take(life);
    const u = m.userData as { from: THREE.Vector3; dir: THREE.Vector3; dist: number; life: number };
    u.from.copy(from);
    u.dir.subVectors(to, from).divideScalar(dist);
    u.dist = dist;
    u.life = life;
    m.quaternion.setFromUnitVectors(FORWARD, u.dir);
    m.scale.set(1, 1, 0.001);
    m.position.copy(from);
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
   * A bullet hitting the map, by what it hit: a mark that stays (MARKS at most, oldest
   * reused), a puff of dust in the surface's colour, chips or splinters off masonry and wood,
   * sparks off metal. `far`: someone else's shot (a lighter version).
   */
  impact(hit: MapHit, far = false): void {
    const look = IMPACT[hit.surface];
    const normal = hit.normal;
    const m = this.impacts.take(MARK_SECONDS);
    m.material.color.setHex(look.mark);
    m.scale.setScalar(look.markSize * (0.85 + Math.random() * 0.3));
    m.position.copy(hit.point).addScaledVector(normal, 0.004);
    m.lookAt(tmp.copy(m.position).add(normal));
    m.rotateZ(Math.random() * Math.PI * 2);
    const puff = this.puffs.take(0.7);
    puff.material.color.setHex(look.dust);
    puff.userData.size = look.dustSize;
    puff.position.copy(hit.point).addScaledVector(normal, 0.08);
    (puff.userData.v as THREE.Vector3).copy(normal).multiplyScalar(0.6).y += 0.25;
    const share = far ? 0.5 : 1;
    for (let i = 0; i < Math.round(look.sparks * share); i++) {
      const sp = this.sparks.take(0.18 + Math.random() * 0.15);
      sp.position.copy(hit.point).addScaledVector(normal, 0.02);
      (sp.userData.v as THREE.Vector3)
        .set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5)
        .multiplyScalar(4)
        .addScaledVector(normal, 3.5);
    }
    for (let i = 0; i < Math.round(look.chips * share); i++) {
      const c = this.chips.take(0.6 + Math.random() * 0.4);
      c.material.color.setHex(look.chipColor);
      c.position.copy(hit.point).addScaledVector(normal, 0.03);
      (c.userData.v as THREE.Vector3)
        .set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5)
        .multiplyScalar(2.5)
        .addScaledVector(normal, 1.5 + Math.random() * 2);
      (c.userData.spin as THREE.Vector3).set(Math.random() * 25, Math.random() * 25, 0);
    }
  }

  /**
   * A soldier eliminated here: a burst of sparks and dust upward and a flash (no gore: PEGI
   * 12), so a kill reads from across the map.
   */
  elimination(at: THREE.Vector3): void {
    for (let i = 0; i < 16; i++) {
      const s = this.sparks.take(0.35 + Math.random() * 0.3);
      s.position.copy(at).setY(at.y + 0.6 + Math.random() * 0.8);
      (s.userData.v as THREE.Vector3).set(
        (Math.random() - 0.5) * 5,
        2 + Math.random() * 3.5,
        (Math.random() - 0.5) * 5,
      );
    }
    for (let i = 0; i < 2; i++) {
      const p = this.puffs.take(0.9);
      p.material.color.setHex(0xb3a592);
      p.userData.size = 1;
      p.position.copy(at).setY(at.y + 0.5 + i * 0.6);
      (p.userData.v as THREE.Vector3).set(0, 0.6, 0);
    }
    this.muzzleLight(at.clone().setY(at.y + 1));
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
    if (down) {
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
    this.tracers.update(frame, (o, k) => {
      const u = o.userData as {
        from: THREE.Vector3;
        dir: THREE.Vector3;
        dist: number;
        life: number;
      };
      const head = Math.min(u.dist, k * u.life * this.tracerSpeed);
      const tail = Math.max(0, head - this.tracerLength);
      o.position.copy(u.from).addScaledVector(u.dir, (head + tail) / 2);
      o.scale.set(1, 1, Math.max(0.001, head - tail));
    });
    this.flashes.update(frame, fade(1));
    // Marks stay, then fade out over the last fifth of their time.
    this.impacts.update(frame, (o, k) => (o.material.opacity = k < 0.8 ? 1 : (1 - k) / 0.2));
    this.chips.update(frame, (o) => {
      const v = o.userData.v as THREE.Vector3;
      v.addScaledVector(this.gravity, frame);
      o.position.addScaledVector(v, frame);
      const spin = o.userData.spin as THREE.Vector3;
      o.rotation.x += spin.x * frame;
      o.rotation.y += spin.y * frame;
    });
    this.puffs.update(frame, (o, k) => {
      o.position.addScaledVector(o.userData.v as THREE.Vector3, frame);
      o.scale.setScalar((0.16 + 0.75 * Math.sqrt(k)) * ((o.userData.size as number) ?? 1));
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
      this.chips,
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

/**
 * A bullet hole, drawn once: a dark core, a torn ragged rim and a few hairline cracks, on
 * transparent. White-ish, so each surface tints it (dark on concrete, bright on metal).
 */
function bulletHole(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const mid = size / 2;
  // Scorched halo.
  const halo = g.createRadialGradient(mid, mid, 4, mid, mid, mid);
  halo.addColorStop(0, 'rgba(255,255,255,0.55)');
  halo.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);
  // Ragged rim and core.
  g.beginPath();
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const r = size * (0.12 + Math.random() * 0.06);
    g.lineTo(mid + Math.cos(a) * r, mid + Math.sin(a) * r);
  }
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fill();
  // Cracks.
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    let a = Math.random() * Math.PI * 2;
    let r = size * 0.14;
    g.beginPath();
    g.moveTo(mid + Math.cos(a) * r, mid + Math.sin(a) * r);
    for (let j = 0; j < 3; j++) {
      a += (Math.random() - 0.5) * 0.6;
      r += size * (0.05 + Math.random() * 0.06);
      g.lineTo(mid + Math.cos(a) * r, mid + Math.sin(a) * r);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
