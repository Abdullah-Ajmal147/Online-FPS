// Dev-only model lab (not in the production build): /lab.html?view=...
// Renders soldiers and weapons for tuning, with the server hitboxes drawn over them.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { hitboxes } from '@sentinel/shared';
import { movement } from '@sentinel/content';

// The lab always draws the models (automated tests otherwise get simple soldiers).
(window as { __sentinelSoldierModels?: boolean }).__sentinelSoldierModels = true;
const params = new URLSearchParams(location.search);
const info = document.getElementById('info')!;
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a4048);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
scene.add(new THREE.HemisphereLight(0xdde6ff, 0x404040, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6, 4);
scene.add(sun);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x55595e }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const load = (u: string) => loader.loadAsync(u);

function drawHitboxes(x: number, crouch: boolean): void {
  const m = new THREE.MeshBasicMaterial({
    color: 0xff2020,
    wireframe: true,
    transparent: true,
    opacity: 0.35,
  });
  for (const c of hitboxes([x, 0, 0], crouch, movement)) {
    const len = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    const g =
      len < 1e-6
        ? new THREE.SphereGeometry(c.r, 12, 8)
        : new THREE.CapsuleGeometry(c.r, len, 6, 12);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set((c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2, (c.a[2] + c.b[2]) / 2);
    scene.add(mesh);
  }
}

const view = params.get('view') ?? 'raw';
const mixers: THREE.AnimationMixer[] = [];
const lines: string[] = [];

if (view === 'raw') {
  const [m, f, anims] = await Promise.all([
    load('/assets/characters/soldier-m.glb'),
    load('/assets/characters/soldier-f.glb'),
    load('/assets/characters/animations.glb'),
  ]);
  const clipName = params.get('clip') ?? 'Idle_Loop';
  const t = Number(params.get('t') ?? 0.3);
  const scale = Number(params.get('scale') ?? 1);
  [m, f].forEach((g, i) => {
    const o = cloneSkinned(g.scene);
    o.scale.setScalar(scale);
    o.position.x = i === 0 ? -0.6 : 0.6;
    scene.add(o);
    const mixer = new THREE.AnimationMixer(o);
    const clip = anims.animations.find((a) => a.name === clipName)!;
    mixer.clipAction(clip).play();
    mixer.setTime(t);
    mixers.push(mixer);
    if (params.has('axes'))
      o.traverse((b) => {
        if (
          (b as THREE.Bone).isBone &&
          /Head|hand_r|spine_03|pelvis|calf_l|upperarm_r/.test(b.name)
        )
          b.add(new THREE.AxesHelper(0.25));
      });
    o.updateMatrixWorld(true);
    const head = o.getObjectByName('Head')!.getWorldPosition(new THREE.Vector3());
    lines.push(`${i ? 'F' : 'M'} head bone y=${head.y.toFixed(3)} z=${head.z.toFixed(3)}`);
    drawHitboxes(o.position.x, clipName.startsWith('Crouch'));
  });
  lines.push('clips: ' + anims.animations.map((a) => a.name).join(' '));
}

if (view === 'dressed') {
  const { loadSoldierAssets, createSoldierModel } = await import('../game/soldier/assets.ts');
  const assets = await loadSoldierAssets();
  const clipName = params.get('clip') ?? 'Idle_Loop';
  const t = Number(params.get('t') ?? 0.3);
  const combos = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const;
  combos.forEach(([team, variant], i) => {
    const s = createSoldierModel(assets, team, variant);
    s.root.position.x = (i - 1.5) * 0.85;
    s.root.rotation.y = Number(params.get('yaw') ?? 0);
    scene.add(s.root);
    const mixer = new THREE.AnimationMixer(s.root);
    const clip = assets.clips.get(clipName);
    if (clip) {
      mixer.clipAction(clip).play();
      mixer.setTime(t);
    }
    mixers.push(mixer);
    if (params.has('hb')) drawHitboxes(s.root.position.x, clipName.startsWith('Crouch'));
  });
  lines.push('dressed: team 0/1 x male/female');
}

if (view === 'guns') {
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
  let i = 0;
  for (const id of ids) {
    const g = await load(`/assets/weapons/${id}.glb`);
    g.scene.rotation.y = Math.PI / 2; // barrel (-Z) to the right of the screen
    g.scene.position.set(((i % 3) - 1) * 1.35, 2.2 - Math.floor(i / 3) * 0.5, 0);
    scene.add(g.scene);
    lines.push(`${i}: ${id}`);
    i++;
  }
}

if (view === 'hold') {
  // Soldiers holding each weapon, driven by a fake pose: ?pitch=&speed=&crouch=&weapon=
  const { loadSoldierAssets, createSoldierModel } = await import('../game/soldier/assets.ts');
  const { SoldierRig } = await import('../game/soldier/rig.ts');
  const assets = await loadSoldierAssets();
  const weapons = (params.get('weapons') ?? 'rifle,smg,shotgun,marksman,sidearm').split(',');
  const pitch = Number(params.get('pitch') ?? 0);
  const speed = Number(params.get('speed') ?? 0);
  const moveDir = Number(params.get('dir') ?? 0); // radians relative to facing
  const yaw = Number(params.get('yaw') ?? -Math.PI / 2); // default: facing +X (side view)
  const crouch = params.has('crouch');
  const alive = !params.has('dead');
  const team = Number(params.get('team') ?? 0);
  const rigs: { rig: InstanceType<typeof SoldierRig>; x: number }[] = [];
  weapons.forEach((wid, i) => {
    const model = createSoldierModel(assets, (i + team) % 2, i % 2);
    const rig = new SoldierRig(assets, model);
    scene.add(model.root);
    rig.setWeapon(wid as never);
    rigs.push({ rig, x: (i - (weapons.length - 1) / 2) * 1.1 });
    if (params.has('hb')) drawHitboxes(rigs[i]!.x, crouch);
  });
  // Simulate 1.2 s so blends and smoothing settle, moving at `speed` along `dir`.
  const heading = yaw + moveDir;
  let t = 0;
  for (let f = 0; f < 72; f++) {
    const dt = 1 / 60;
    t += dt;
    for (const { rig, x } of rigs) {
      const d = speed * t;
      rig.update(
        {
          position: [x - Math.sin(heading) * d * 0 + 0, 0, 0].map(
            (v, k) =>
              (k === 0 ? x : 0) +
              (k === 0 ? -Math.sin(heading) * d : k === 2 ? -Math.cos(heading) * d : 0),
          ) as [number, number, number],
          yaw,
          pitch,
          crouching: crouch,
          alive: f < 10 || alive,
          team: 0,
        },
        dt,
      );
    }
  }
  // Put them back in a row for the picture (the animation state stays).
  for (const { rig, x } of rigs) {
    const dx = x - rig.root.position.x;
    rig.root.position.x += dx;
    rig.root.position.z = 0;
    rig.update({ position: [x, 0, 0], yaw, pitch, crouching: crouch, alive, team: 0 }, 0);
  }
  lines.push(`hold: pitch ${pitch} speed ${speed} crouch ${crouch}`);
  const hh = (crouch ? movement.crouchHeight : movement.standingHeight) * 0.9;
  for (const { rig, x } of rigs) {
    const h = rig.head(new THREE.Vector3());
    lines.push(
      `head vs hitbox: dx ${(h.x - x).toFixed(3)} dy ${(h.y - hh).toFixed(3)} dz ${h.z.toFixed(3)}  (r 0.14)`,
    );
  }
}

if (view === 'bench') {
  // CPU cost of animating 11 soldiers (the GPU side is ~13k triangles each).
  const { loadSoldierAssets, createSoldierModel } = await import('../game/soldier/assets.ts');
  const { SoldierRig } = await import('../game/soldier/rig.ts');
  const assets = await loadSoldierAssets();
  const rigs = Array.from({ length: 11 }, (_, i) => {
    const m = createSoldierModel(assets, i % 2, i % 2);
    scene.add(m.root);
    const r = new SoldierRig(assets, m);
    r.setWeapon((['rifle', 'smg', 'shotgun', 'marksman', 'sidearm'] as const)[i % 5]!);
    return r;
  });
  const frames = 600;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    rigs.forEach((r, i) => {
      const t = f / 60 + i;
      r.update(
        {
          position: [Math.sin(t * 0.7) * 5 + i, 0, Math.cos(t * 0.5) * 5],
          yaw: t * 0.3,
          pitch: Math.sin(t) * 0.4,
          crouching: (f + i * 40) % 300 > 220,
          alive: true,
          team: i % 2,
        },
        1 / 60,
      );
    });
  }
  const ms = (performance.now() - t0) / frames;
  lines.push(`bench: 11 soldiers, ${ms.toFixed(3)} ms per frame`);
}

if (view === 'stress') {
  // What 11 soldiers cost end to end: build, first frame (shader setup), steady frames.
  const { loadSoldierAssets, createSoldierModel } = await import('../game/soldier/assets.ts');
  const { SoldierRig } = await import('../game/soldier/rig.ts');
  const t0 = performance.now();
  const assets = await loadSoldierAssets();
  if (params.has('predress'))
    for (const [t, v] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const)
      createSoldierModel(assets, t, v);
  const t1 = performance.now();
  const rigs = Array.from({ length: 11 }, (_, i) => {
    const m = createSoldierModel(assets, i % 2, i % 2);
    scene.add(m.root);
    const r = new SoldierRig(assets, m);
    r.setWeapon('rifle');
    return r;
  });
  const t2 = performance.now();
  if (params.has('compile')) await renderer.compileAsync(scene, camera);
  const t3 = performance.now();
  camera.position.set(0, 1.6, 9);
  camera.lookAt(0, 1, 0);
  const step = (f: number) =>
    rigs.forEach((r, i) =>
      r.update(
        {
          position: [(i - 5) * 0.9, 0, Math.sin(f / 30 + i)],
          yaw: 0,
          pitch: 0,
          crouching: false,
          alive: true,
          team: i % 2,
        },
        1 / 60,
      ),
    );
  step(0);
  renderer.render(scene, camera);
  const t4 = performance.now();
  const times: number[] = [];
  for (let f = 1; f < 40; f++) {
    const a = performance.now();
    step(f);
    renderer.render(scene, camera);
    times.push(performance.now() - a);
  }
  times.sort((x, y) => x - y);
  lines.push(
    `stress: load ${(t1 - t0).toFixed(0)} ms, build 11 ${(t2 - t1).toFixed(0)} ms, compile ${(t3 - t2).toFixed(0)} ms, first frame ${(t4 - t3).toFixed(0)} ms, median frame ${times[20]!.toFixed(1)} ms`,
  );
}

let fpCamera: THREE.PerspectiveCamera | null = null;
if (view === 'fp') {
  // First person: ?weapon=rifle&ads=0..1&team=0
  const { Viewmodel } = await import('../game/viewmodel.ts');
  const { loadSoldierAssets } = await import('../game/soldier/assets.ts');
  const { weaponCatalog } = await import('@sentinel/content');
  await loadSoldierAssets();
  fpCamera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.02, 100);
  fpCamera.position.set(0, 1.6, 2);
  scene.add(fpCamera);
  const vm = new Viewmodel(fpCamera);
  await new Promise((r) => setTimeout(r, 200));
  const cls = params.get('weapon') ?? 'rifle';
  const w = Object.values(weaponCatalog).find((x) => x.class === cls)!;
  vm.setLoadout(w, w);
  vm.setTeam(Number(params.get('team') ?? 0));
  const ads = Number(params.get('ads') ?? 0);
  for (let i = 0; i < 3; i++)
    vm.update(1 / 60, { slot: 0, ads, reloading: 0, switching: 0, speed: 0, grounded: true });
  lines.push(`fp: ${cls} ads ${ads}`);
}

const cam = (params.get('cam') ?? '0,1.1,4.2').split(',').map(Number);
camera.position.set(cam[0]!, cam[1]!, cam[2]!);
camera.lookAt(0, Number(params.get('look') ?? 0.95), 0);
info.textContent = lines.join('\n');
(window as unknown as { __labReady: boolean }).__labReady = true;
renderer.setAnimationLoop(() => renderer.render(scene, fpCamera ?? camera));
