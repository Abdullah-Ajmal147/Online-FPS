import * as THREE from 'three/webgpu';
import { maps, movement } from '@sentinel/content';
import {
  SKIN,
  buildWorld,
  capsuleHeight,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  expandMap,
  initPhysics,
  step,
  yawFromDegrees,
  yawToRadians,
  type PlayerState,
} from '@sentinel/shared';
import { verticalFovDegrees } from '../camera.ts';
import { InputCapture } from '../input/capture.ts';
import { buildMapMeshes } from '../map.ts';
import type { Settings } from '../settings.ts';
import { setStatus } from '../store.ts';
import { advanceFixedStep } from './fixedStep.ts';

export interface Game {
  requestPlay(): Promise<void>;
  backend: 'WebGPU' | 'WebGL 2';
}

/**
 * Local practice mode (Phase 1, tasks 3–4): the browser runs the shared movement simulation
 * for its own player so movement can be tried and tuned. The same step() becomes client-side
 * prediction in task 7, when the server takes over authority.
 */
export async function startGame(
  canvas: HTMLCanvasElement,
  settings: () => Settings,
): Promise<Game> {
  // --- Renderer ---
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  console.info(`[renderer] backend: ${backend}`);

  const map = maps.greybox!;
  const solids = expandMap(map);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb6c9);
  scene.fog = new THREE.Fog(0x9fb6c9, 60, 140);
  scene.add(buildMapMeshes(solids));
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x3a3f47, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(20, 40, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, far: 100 });
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 250);
  camera.rotation.order = 'YXZ'; // yaw first, then pitch: no roll creeping in
  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.fov = verticalFovDegrees(settings().fov, camera.aspect);
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  resize();
  window.addEventListener('resize', resize);

  // --- Simulation (same code the server will run) ---
  const rapier = await initPhysics();
  const world = buildWorld(rapier, solids);
  const ctx = createMovementContext(rapier, world, movement);
  const body = createPlayerBody(ctx);
  const spawn = map.spawns[0]!;
  const spawnState = () => createPlayerState(spawn.position, yawFromDegrees(spawn.yawDeg));
  let state: PlayerState = spawnState();
  let prevState = state;

  const input = new InputCapture(canvas, settings, yawToRadians(state.yaw), (playing) =>
    setStatus({ playing }),
  );

  // --- Frame loop ---
  const timer = new THREE.Timer();
  let accumulator = 0;
  let eyeHeight = eyeHeightFor(state.crouching);
  let bobPhase = 0;
  let lastHud = 0;

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const frame = timer.getDelta();
    const fixed = advanceFixedStep(accumulator, frame);
    accumulator = fixed.accumulator;
    for (let i = 0; i < fixed.ticks; i++) {
      prevState = state;
      state = step(state, input.sample(), ctx, body);
      if (state.position[1] < map.killY) state = prevState = spawnState();
    }

    // Interpolate between the last two ticks so motion is smooth at any refresh rate.
    const a = fixed.alpha;
    const px = lerp(prevState.position[0], state.position[0], a);
    const py = lerp(prevState.position[1], state.position[1], a);
    const pz = lerp(prevState.position[2], state.position[2], a);

    // Ease the eye between standing and crouching height (~0.1 s) instead of popping.
    eyeHeight += (eyeHeightFor(state.crouching) - eyeHeight) * Math.min(1, frame * 15);

    const speed = Math.hypot(state.velocity[0], state.velocity[2]);
    let bob = 0;
    if (settings().headBob && state.grounded && speed > 0.5) {
      bobPhase += frame * speed * 1.8;
      bob = Math.sin(bobPhase) * 0.03;
    }

    camera.position.set(px, py + eyeHeight + bob, pz);
    // Mouse look is applied every frame from the live look angles, not per tick: no input lag.
    camera.rotation.set(input.look.pitch, input.look.yaw, 0);
    const vfov = verticalFovDegrees(settings().fov, camera.aspect);
    if (camera.fov !== vfov) {
      camera.fov = vfov;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);

    if (time - lastHud > 100) {
      lastHud = time;
      setStatus({
        player: {
          position: state.position,
          speed,
          grounded: state.grounded,
          crouching: state.crouching,
          sliding: state.slideTicks > 0,
        },
      });
    }
  });

  return { backend, requestPlay: () => input.requestLock() };
}

function eyeHeightFor(crouching: boolean): number {
  return SKIN + capsuleHeight(movement, crouching) - movement.eyeOffset;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
