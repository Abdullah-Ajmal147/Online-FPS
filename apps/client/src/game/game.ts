import * as THREE from 'three/webgpu';
import { maps, movement } from '@sentinel/content';
import type { Snapshot } from '@sentinel/protocol';
import {
  SKIN,
  TICKS_PER_SNAPSHOT,
  buildWorld,
  capsuleHeight,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  expandMap,
  initPhysics,
  yawFromDegrees,
  yawToRadians,
  type PlayerState,
} from '@sentinel/shared';
import { verticalFovDegrees } from '../camera.ts';
import { InputCapture } from '../input/capture.ts';
import { buildMapMeshes } from '../map.ts';
import { Connection } from '../net.ts';
import { ServerClock, inputPacing, TARGET_QUEUE_DEPTH } from '../net/clock.ts';
import { InterpolationDelay, RemoteBuffer } from '../net/interpolator.ts';
import { Predictor } from '../net/predictor.ts';
import type { Settings } from '../settings.ts';
import { setStatus } from '../store.ts';
import { advanceFixedStep } from './fixedStep.ts';
import { RemotePlayers } from './remotePlayers.ts';

export interface Game {
  requestPlay(): Promise<void>;
  backend: 'WebGPU' | 'WebGL 2';
}

/**
 * The game client. Our own player is predicted locally with the shared step() and reconciled
 * with the server's snapshots; other players are interpolated between snapshots.
 * If the server can't be reached, the same loop runs as offline practice (no reconciliation).
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

  // --- Simulation (same code the server runs) ---
  const rapier = await initPhysics();
  const world = buildWorld(rapier, solids);
  const ctx = createMovementContext(rapier, world, movement);
  const body = createPlayerBody(ctx);
  const spawn = map.spawns[0]!;
  const predictor = new Predictor(
    createPlayerState(spawn.position, yawFromDegrees(spawn.yawDeg)),
    ctx,
    body,
  );
  let prevState: PlayerState = predictor.state;

  const input = new InputCapture(canvas, settings, yawToRadians(predictor.state.yaw), (playing) =>
    setStatus({ playing }),
  );

  // --- Network ---
  const conn = new Connection();
  const clock = new ServerClock();
  const interpDelay = new InterpolationDelay();
  const remoteBuffers = new Map<number, RemoteBuffer>();
  const remotePlayers = new RemotePlayers(scene);
  let latestServerTick = 0;
  let spawnedFromServer = false;
  let queueDepth = TARGET_QUEUE_DEPTH;
  let lastServerTickMicros = 0;
  let snapshotsSeen = 0;
  let snapshotsMissed = 0;

  const onSnapshot = (snap: Snapshot, arrivalMs: number) => {
    if (snap.serverTick <= latestServerTick) return; // out of order: newer data already applied
    if (latestServerTick > 0) {
      snapshotsMissed += Math.max(0, (snap.serverTick - latestServerTick) / TICKS_PER_SNAPSHOT - 1);
    }
    snapshotsSeen++;
    latestServerTick = snap.serverTick;
    lastServerTickMicros = snap.serverTickMicros;
    queueDepth += (snap.inputQueueDepth - queueDepth) * 0.1;
    clock.onSnapshot(snap.serverTick, arrivalMs);
    interpDelay.onSnapshotArrival(arrivalMs);

    if (snap.own) {
      if (!spawnedFromServer) {
        // First contact: take the server's spawn, then predict from there.
        spawnedFromServer = true;
        predictor.state = { ...snap.own, yaw: predictor.state.yaw, pitch: predictor.state.pitch };
        prevState = predictor.state;
      } else {
        predictor.onServerState(snap.own, snap.lastProcessedSeq);
      }
    }

    const present = new Set<number>();
    for (const e of snap.entities) {
      present.add(e.id);
      let buf = remoteBuffers.get(e.id);
      if (!buf) remoteBuffers.set(e.id, (buf = new RemoteBuffer()));
      buf.push(snap.serverTick, e);
    }
    for (const id of remoteBuffers.keys()) if (!present.has(id)) remoteBuffers.delete(id);
    remotePlayers.retain(present);
  };

  void conn.connect({ onHello: () => {}, onSnapshot });

  // --- Frame loop ---
  const timer = new THREE.Timer();
  let accumulator = 0;
  let eyeHeight = eyeHeightFor(predictor.state.crouching);
  let bobPhase = 0;
  let lastHud = 0;
  let frames = 0;

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const frame = timer.getDelta();
    frames++;

    // Run slightly faster/slower to keep ~2 inputs queued on the server (online only).
    const pace = spawnedFromServer ? inputPacing(queueDepth) : 1;
    const fixed = advanceFixedStep(accumulator, frame * pace);
    accumulator = fixed.accumulator;
    for (let i = 0; i < fixed.ticks; i++) {
      prevState = predictor.state;
      predictor.tick({ ...input.sample(), weaponSlot: 0 });
      if (conn.connected && spawnedFromServer) {
        conn.sendInput({ ackServerTick: latestServerTick, inputs: predictor.recentInputs() });
      }
      if (!spawnedFromServer && predictor.state.position[1] < map.killY) {
        predictor.state = prevState = createPlayerState(
          spawn.position,
          yawFromDegrees(spawn.yawDeg),
        );
      }
    }
    predictor.decayOffset(frame);

    // Own player: interpolate between the last two ticks, plus any correction still blending out.
    const a = fixed.alpha;
    const s = predictor.state;
    const off = predictor.renderOffset;
    const px = lerp(prevState.position[0], s.position[0], a) + off[0];
    const py = lerp(prevState.position[1], s.position[1], a) + off[1];
    const pz = lerp(prevState.position[2], s.position[2], a) + off[2];

    // Ease the eye between standing and crouching height (~0.1 s) instead of popping.
    eyeHeight += (eyeHeightFor(s.crouching) - eyeHeight) * Math.min(1, frame * 15);

    const speed = Math.hypot(s.velocity[0], s.velocity[2]);
    let bob = 0;
    if (settings().headBob && s.grounded && speed > 0.5) {
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

    // Remote players: drawn in the past, between two snapshots we already have.
    const serverNow = clock.now(performance.now());
    if (serverNow !== null) {
      const renderTick = serverNow - interpDelay.ticks;
      for (const [id, buf] of remoteBuffers) {
        const pose = buf.sample(renderTick);
        if (pose) remotePlayers.update(id, pose);
      }
    }

    renderer.render(scene, camera);

    if (time - lastHud > 250) {
      const fps = (frames * 1000) / (time - lastHud || 1);
      frames = 0;
      lastHud = time;
      const st = predictor.stats;
      setStatus({
        fps,
        player: {
          position: s.position,
          speed,
          grounded: s.grounded,
          crouching: s.crouching,
          sliding: s.slideTicks > 0,
        },
        netStats: spawnedFromServer
          ? {
              rttMs: conn.rttMs,
              correctionPct: st.snapshots ? (100 * st.corrections) / st.snapshots : 0,
              lastErrorCm: st.lastError * 100,
              snapshotLossPct:
                snapshotsSeen + snapshotsMissed
                  ? (100 * snapshotsMissed) / (snapshotsSeen + snapshotsMissed)
                  : 0,
              serverTickMs: lastServerTickMicros / 1000,
              inputQueueDepth: queueDepth,
              interpDelayMs: (interpDelay.ticks * 1000) / 60,
              remotePlayers: remoteBuffers.size,
            }
          : null,
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
