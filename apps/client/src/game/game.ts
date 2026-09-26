import * as THREE from 'three/webgpu';
import {
  defaultLoadout,
  killSourceName,
  maps,
  movement,
  weaponCatalog,
  buildLoadout,
  loadoutFromWire,
  loadoutToWire,
  type GameMap,
  type Weapon,
} from '@sentinel/content';
import {
  DRAW,
  MatchPhase,
  type GameEvent,
  type MatchInfo,
  type Snapshot,
} from '@sentinel/protocol';
import {
  Predictor,
  SKIN,
  TICKS_PER_SNAPSHOT,
  UNITS_PER_DEGREE,
  adsFraction,
  buildWorld,
  capsuleHeight,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  createSimContext,
  createWeaponState,
  currentSpread,
  directionFromAngles,
  expandMap,
  eyePosition,
  initPhysics,
  rayPlayer,
  yawFromDegrees,
  yawToRadians,
  type MovementContext,
  type ShotRequest,
  type SimContext,
  type SimState,
} from '@sentinel/shared';
import { GameAudio } from '../audio.ts';
import { verticalFovDegrees } from '../camera.ts';
import { InputCapture } from '../input/capture.ts';
import { buildMapMeshes } from '../map.ts';
import { Connection } from '../net.ts';
import { ServerClock, inputPacing, TARGET_QUEUE_DEPTH } from '@sentinel/shared';
import { InterpolationDelay, RemoteBuffer, type RemotePose } from '@sentinel/shared';
import { loadoutChoice, type GraphicsPreset, type Settings } from '../settings.ts';
import { ensureGuest, refreshProfile } from '../profile.ts';
import { setStatus, type CombatHud, type KillFeedEntry, getStatus } from '../store.ts';
import { Effects } from './effects.ts';
import { advanceFixedStep } from './fixedStep.ts';
import { Feedback } from './feedback.ts';
import { RemotePlayers } from './remotePlayers.ts';
import { GrenadeView } from './grenadeView.ts';
import { Viewmodel } from './viewmodel.ts';

export interface Game {
  requestPlay(): Promise<void>;
  backend: 'WebGPU' | 'WebGL 2';
}

const TEAM_NAMES = ['Aegis', 'Ember'];
const RAD_PER_UNIT = (2 * Math.PI) / 65536;

/**
 * The game client. Our own player (movement + weapon) is predicted locally with the shared
 * stepSim() and reconciled with the server's snapshots; other players are interpolated between
 * snapshots. The server decides every hit; the client only shows predictions and confirmations.
 * If the server can't be reached, the same loop runs as offline practice.
 */
export async function startGame(
  canvas: HTMLCanvasElement,
  settings: () => Settings,
): Promise<Game> {
  // --- Renderer ---
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: !(await webgpuAvailable()),
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  console.info(`[renderer] backend: ${backend}`);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8ec3ef);
  scene.fog = new THREE.Fog(0x8ec3ef, 70, 160);
  const hemi = new THREE.HemisphereLight(0xe8f3ff, 0x5a5048, 1.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  sun.position.set(20, 40, 15);
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, far: 100 });
  scene.add(sun);

  // Shadows are set once, before the first frame: three's WebGPU shadow node does not survive
  // having its shadow map switched off/on or resized later (null depth texture crash).
  const startQuality = GRAPHICS[settings().graphics];
  sun.castShadow = startQuality.shadowMapSize > 0;
  if (sun.castShadow)
    sun.shadow.mapSize.set(startQuality.shadowMapSize, startQuality.shadowMapSize);

  /** Resolution (preset pixel-ratio cap × render scale), applied live when the menu changes. */
  let appliedGraphics = '';
  function applyGraphics(): void {
    const { graphics, renderScale } = settings();
    const key = `${graphics}|${renderScale}`;
    if (key === appliedGraphics) return;
    appliedGraphics = key;
    const q = GRAPHICS[graphics];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio) * renderScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  applyGraphics();

  const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 250);
  camera.rotation.order = 'YXZ'; // yaw first, then pitch: no roll creeping in
  scene.add(camera); // the viewmodel hangs off the camera
  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.fov = verticalFovDegrees(settings().fov, camera.aspect);
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  resize();
  window.addEventListener('resize', resize);

  const viewmodel = new Viewmodel(camera);
  const feedback = new Feedback(document.getElementById('ui')!);
  const audio = new GameAudio();
  const rapier = await initPhysics();

  // --- Map + simulation (same code the server runs). Rebuilt when the server names its map. ---
  let map!: GameMap;
  let mapMeshes: THREE.Group | null = null;
  /** Map just changed: hold still until the server's spawn on the new map arrives. */
  let awaitingSpawn = false;
  let moveCtx!: MovementContext;
  let simCtx!: SimContext;
  /** Our loadout as the server confirmed it; we predict with exactly these weapons. */
  let loadout: readonly [Weapon, Weapon] = defaultLoadout;
  let loadoutKey = '';
  let predictor!: Predictor; // all assigned by loadMap() right below
  const effects = new Effects(scene);
  const grenadeView = new GrenadeView(scene);
  const freshSim = (): SimState => {
    const spawn = map.spawns[0]!;
    return {
      move: createPlayerState(spawn.position, yawFromDegrees(spawn.yawDeg)),
      weapon: createWeaponState(simCtx.loadout),
    };
  };
  function loadMap(id: string): void {
    const next = maps[id];
    if (!next) throw new Error(`unknown map "${id}"`);
    map = next;
    const solids = expandMap(map);
    if (mapMeshes) {
      scene.remove(mapMeshes);
      mapMeshes.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    const oldWorld = moveCtx?.world;
    mapMeshes = buildMapMeshes(solids);
    scene.add(mapMeshes);
    effects.setSolids(mapMeshes);
    grenadeView.clear();
    applyLighting(map.lighting);
    setStatus({ mapName: map.name });
    moveCtx = createMovementContext(rapier, buildWorld(rapier, solids), movement);
    simCtx = createSimContext(moveCtx, loadout);
    const body = createPlayerBody(moveCtx);
    // Map rotation mid-session: keep the predictor (its input sequence numbers must keep
    // counting up, or the server would drop our inputs as old) and just swap its world.
    if (predictor) {
      predictor.reset(predictor.state, undefined, simCtx, body);
      // Until the server's spawn on the new map arrives, stand still (our position is still an
      // old-map one; stepping it through the new geometry would only show a glitch).
      awaitingSpawn = true;
    } else {
      predictor = new Predictor(freshSim(), simCtx, body);
    }
    oldWorld?.free(); // nothing references it now (predictor and simCtx use the new one)
  }
  function applyLighting(preset: GameMap['lighting']): void {
    const l = LIGHTING[preset];
    (scene.background as THREE.Color).set(l.sky);
    (scene.fog as THREE.Fog).color.set(l.sky);
    (scene.fog as THREE.Fog).near = l.fogNear;
    (scene.fog as THREE.Fog).far = l.fogFar;
    hemi.color.set(l.hemiSky);
    hemi.groundColor.set(l.hemiGround);
    hemi.intensity = l.hemiIntensity;
    sun.color.set(l.sun);
    sun.intensity = l.sunIntensity;
    sun.position.set(...l.sunPosition);
  }

  loadMap('greybox'); // offline practice until the server tells us its map
  let prevState: SimState = predictor.state;

  const input = new InputCapture(
    canvas,
    settings,
    yawToRadians(predictor.state.move.yaw),
    (playing) => setStatus({ playing }),
  );

  // --- Combat HUD state ---
  const hud: CombatHud = {
    alive: true,
    health: 100,
    weaponName: defaultLoadout[0].name,
    ammo: defaultLoadout[0].magazine,
    reserve: defaultLoadout[0].reserve,
    frags: 1,
    smokes: 1,
    reloading: false,
    respawnSeconds: 0,
    killedBy: null,
    hitAt: -Infinity,
    hitKind: 'hit',
    damage: [],
    killFeed: [],
    announcements: [],
  };
  let hudDirty = true;
  let feedKey = 0;
  let myId = 0;
  const teamOf = new Map<number, number>();
  const names = new Map<number, string>();
  const nameOf = (id: number) =>
    id === myId ? 'You' : (names.get(id) ?? `${TEAM_NAMES[teamOf.get(id) ?? 0]} ${id}`);
  /** Countdown and results: the server freezes everyone, so we send no movement or fire. */
  let frozen = false;
  let lastPhase: number = MatchPhase.Warmup;

  const PHASES = ['warmup', 'countdown', 'live', 'ended'] as const;
  const onMatchInfo = (info: MatchInfo) => {
    for (const p of info.players) {
      names.set(p.id, p.name);
      teamOf.set(p.id, p.team);
    }
    const wasEnded = frozen && lastPhase === MatchPhase.Ended;
    frozen = info.phase === MatchPhase.Countdown || info.phase === MatchPhase.Ended;
    if (info.phase === MatchPhase.Countdown) {
      // New match: first blood is up for grabs again, streaks start over.
      firstBloodTaken = false;
      streak = 0;
    }
    // Match just ended: the server reports it to the API; show the new XP shortly after.
    if (info.phase === MatchPhase.Ended && lastPhase !== MatchPhase.Ended && !wasEnded) {
      // Twice: the report may still be on its way at the first try.
      setTimeout(() => void refreshProfile(), 1500);
      setTimeout(() => void refreshProfile(), 5000);
    }
    if (info.phase === MatchPhase.Live && lastPhase !== MatchPhase.Live) {
      setStatus({ xpBaseline: getStatus().profile?.lastMatch?.matchId ?? null });
    }
    lastPhase = info.phase;
    const mine = myTeam();
    const mvp = info.players.find((p) => p.id === info.mvp);
    setStatus({
      match: {
        phase: PHASES[info.phase]!,
        secondsLeft: info.secondsLeft,
        scoreLimit: info.scoreLimit,
        scores: [info.teamScores[mine as 0 | 1], info.teamScores[(1 - mine) as 0 | 1]],
        myTeam: mine,
        result:
          info.phase !== MatchPhase.Ended
            ? null
            : info.winner === DRAW
              ? 'draw'
              : info.winner === mine
                ? 'win'
                : 'loss',
        mvp: mvp ? (mvp.id === myId ? `${mvp.name} (you)` : mvp.name) : null,
        players: info.players.map((p) => ({ ...p, me: p.id === myId })),
      },
    });
  };

  // --- Network ---
  const conn = new Connection();
  const clock = new ServerClock();
  const interpDelay = new InterpolationDelay();
  const remoteBuffers = new Map<number, RemoteBuffer>();
  const remotePlayers = new RemotePlayers(scene);
  const remotePoses = new Map<number, RemotePose>();
  const remoteShots = new Map<number, number>();
  // Test hook for Playwright: where remote players are drawn. Harmless in production.
  (window as unknown as { __sentinelRemotes?: () => number[][] }).__sentinelRemotes = () =>
    remotePlayers.positions();
  if (import.meta.env.DEV) {
    // Dev/test only: enemies as drawn, with line of sight from our eyes (Playwright "player" tests).
    (window as unknown as { __sentinelDebug?: unknown }).__sentinelDebug = {
      /** Current recoil offset of the view, radians [yaw, pitch] (a person re-aims against it). */
      recoil: () => [
        predictor.state.weapon.recoilYaw * RAD_PER_UNIT,
        predictor.state.weapon.recoilPitch * RAD_PER_UNIT,
      ],
      targets: () =>
        [...remotePoses.entries()].map(([id, p]) => {
          const eye = eyePosition(predictor.state.move, moveCtx);
          const aim = [p.position[0], p.position[1] + 1.1, p.position[2]] as const;
          const d = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]] as const;
          const len = Math.hypot(d[0], d[1], d[2]);
          const blocked = moveCtx.world.castRay(
            new rapier.Ray(
              { x: eye[0], y: eye[1], z: eye[2] },
              { x: d[0] / len, y: d[1] / len, z: d[2] / len },
            ),
            len,
            true,
            rapier.QueryFilterFlags.EXCLUDE_SENSORS,
          );
          return {
            id,
            enemy: p.team !== myTeam(),
            alive: p.alive,
            visible: !blocked,
            position: p.position,
          };
        }),
    };
  }
  let latestServerTick = 0;
  let spawnedFromServer = false;
  let lifeId = -1;
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

    const own = snap.own;
    if (own) {
      const alive = own.respawnTicks === 0;
      if (!spawnedFromServer || own.lifeId !== lifeId) {
        // Joined or respawned: take the server's state and predict from there
        // (on respawn, replaying inputs the server hasn't applied yet).
        const joining = !spawnedFromServer;
        spawnedFromServer = true;
        lifeId = own.lifeId;
        awaitingSpawn = false;
        const look = predictor.state.move;
        let ctx: SimContext | undefined;
        const key = JSON.stringify(own.loadout);
        if (key !== loadoutKey) {
          // Same content build as the server (content hash), so this is exactly its weapons.
          loadoutKey = key;
          loadout = loadoutFromWire(own.loadout).weapons;
          ctx = simCtx = createSimContext(moveCtx, loadout);
          viewmodel.setLoadout(loadout[0], loadout[1]);
        }
        predictor.reset(
          { move: { ...own.sim.move, yaw: look.yaw, pitch: look.pitch }, weapon: own.sim.weapon },
          joining ? undefined : snap.lastProcessedSeq,
          ctx,
        );
        prevState = predictor.state;
      } else if (alive) {
        const before = predictor.state.move.position;
        predictor.onServerState(own.sim, snap.lastProcessedSeq);
        // Shift the previous tick by the same correction, so the in-between frames don't pop.
        const after = predictor.state.move.position;
        if (after !== before) {
          const p = prevState.move.position;
          prevState = {
            ...prevState,
            move: {
              ...prevState.move,
              position: [
                p[0] + after[0] - before[0],
                p[1] + after[1] - before[1],
                p[2] + after[2] - before[2],
              ],
            },
          };
        }
      }
      if (hud.alive !== alive || hud.health !== own.health) hudDirty = true;
      hud.alive = alive;
      hud.health = own.health;
      hud.respawnSeconds = own.respawnTicks / 60;
      if (hud.frags !== own.frags || hud.smokes !== own.smokes) hudDirty = true;
      hud.frags = own.frags;
      hud.smokes = own.smokes;
      if (alive) hud.killedBy = null;
    }

    grenadeView.onSnapshot(snap.serverTick, snap.projectiles);
    const present = new Set<number>();
    for (const e of snap.entities) {
      present.add(e.id);
      teamOf.set(e.id, e.team);
      let buf = remoteBuffers.get(e.id);
      if (!buf) remoteBuffers.set(e.id, (buf = new RemoteBuffer()));
      buf.push(snap.serverTick, e);
      // A remote player fired since the last snapshot: muzzle flash, tracer, 3D sound.
      const lastShots = remoteShots.get(e.id);
      if (lastShots !== undefined && lastShots !== e.shotCount && e.alive)
        remoteFired(e.id, e.weapon);
      remoteShots.set(e.id, e.shotCount);
    }
    for (const id of remoteBuffers.keys()) {
      if (!present.has(id)) {
        remoteBuffers.delete(id);
        remotePoses.delete(id);
        remoteShots.delete(id);
      }
    }
    remotePlayers.retain(present);
  };

  const onEvents = (events: GameEvent[]) => {
    for (const ev of events) {
      if (ev.type === 'hit') {
        hud.hitAt = performance.now();
        hud.hitKind = ev.killed ? 'kill' : ev.zone === 'head' ? 'head' : 'hit';
        audio.hit(hud.hitKind as 'hit' | 'head' | 'kill');
        remotePlayers.flash(ev.victim);
        const head = remotePlayers.headOf(ev.victim, new THREE.Vector3());
        if (head)
          feedback.damage(
            head.setY(head.y - 0.35),
            ev.damage,
            hud.hitKind as 'hit' | 'head' | 'kill',
          );
      } else if (ev.type === 'damaged') {
        const me = predictor.state.move.position;
        const toAttacker = Math.atan2(-(ev.from[0] - me[0]), -(ev.from[2] - me[2]));
        const angle = ((input.look.yaw - toAttacker) * 180) / Math.PI;
        hud.damage = [...hud.damage.slice(-5), { key: feedKey++, angle, at: performance.now() }];
        hud.health = ev.health;
        audio.hurt();
      } else if (ev.type === 'explosion') {
        const [x, y, z] = ev.position;
        if (ev.kind === 'frag') effects.explosion(new THREE.Vector3(x, y, z));
        audio.explosion(ev.kind, ev.position);
      } else if (ev.type === 'kill') {
        const entry: KillFeedEntry = {
          key: feedKey++,
          killer: nameOf(ev.killer),
          killerTeam: ev.killer === myId ? myTeam() : (teamOf.get(ev.killer) ?? 0),
          victim: nameOf(ev.victim),
          victimTeam: ev.victim === myId ? myTeam() : (teamOf.get(ev.victim) ?? 0),
          weapon: killSourceName(ev.weapon) || 'fell',
          headshot: ev.headshot,
        };
        hud.killFeed = [...hud.killFeed.slice(-4), entry];
        if (ev.victim === myId && ev.killer !== myId) hud.killedBy = nameOf(ev.killer);
        if (ev.victim === myId) streak = 0;
        if (ev.killer !== ev.victim && !firstBloodTaken) {
          firstBloodTaken = true;
          if (ev.killer === myId) announce('medal', 'FIRST BLOOD');
        }
        if (ev.killer === myId && ev.victim !== myId) onMyKill(nameOf(ev.victim), ev.headshot);
      }
    }
    hudDirty = true;
  };

  // --- Kill rewards: confirmation, multi-kills, streaks ---
  let firstBloodTaken = false;
  let streak = 0;
  let recentKills: number[] = [];
  const announce = (kind: 'kill' | 'medal', text: string, sub = '') => {
    const now = performance.now();
    hud.announcements = [
      ...hud.announcements.filter((a) => now - a.at < 2500).slice(-3),
      { key: feedKey++, kind, text, sub, at: now },
    ];
    if (kind === 'medal') audio.medal();
    hudDirty = true;
  };
  function onMyKill(victim: string, headshot: boolean): void {
    const now = performance.now();
    announce('kill', `ELIMINATED ${victim.toUpperCase()}`, headshot ? '+100 · HEADSHOT' : '+100');
    recentKills = [...recentKills.filter((t) => now - t < 4000), now];
    streak++;
    const multi = ['', '', 'DOUBLE KILL', 'TRIPLE KILL'][recentKills.length] ?? 'MULTI KILL';
    if (multi) announce('medal', multi);
    if (streak === 5) announce('medal', 'KILLING SPREE');
    if (streak === 10) announce('medal', 'UNSTOPPABLE');
  }

  let myTeamCache = 0;
  const myTeam = () => myTeamCache;

  const onDisconnect = () => {
    // Back to offline practice: keep playing locally where we are.
    spawnedFromServer = false;
    latestServerTick = 0;
    remoteBuffers.clear();
    remotePoses.clear();
    remotePlayers.retain(new Set());
    hud.alive = true;
    hudDirty = true;
    frozen = false;
    setStatus({ match: null });
  };

  const guest = await ensureGuest(); // signed guest token (XP); the game works without it
  void conn.connect(
    {
      onHello: (hello) => {
        myId = hello.playerId;
        myTeamCache = hello.team;
        if (hello.mapId !== map.id) {
          loadMap(hello.mapId);
          prevState = predictor.state;
        }
      },
      onSnapshot,
      onEvents,
      onMatchInfo,
      onDisconnect,
    },
    {
      name: settings().name,
      token: guest?.token ?? null,
      loadout: loadoutChoice(settings()),
    },
  );
  let sentLoadout = JSON.stringify(loadoutChoice(settings()));
  let lastLoadoutSendMs = -Infinity;
  /**
   * Menu changed the loadout mid-match: tell the server (applies at our next spawn). The server
   * ignores changes closer than 250 ms apart, so we send at most every 300 ms; a change made
   * in between is sent when the window opens (checked every frame), never lost.
   */
  function syncLoadout(): void {
    const choice = loadoutChoice(settings());
    const key = JSON.stringify(choice);
    const now = performance.now();
    if (key === sentLoadout || !conn.connected || now - lastLoadoutSendMs < 300) return;
    sentLoadout = key;
    lastLoadoutSendMs = now;
    conn.sendLoadout(loadoutToWire(buildLoadout(choice)));
  }

  // --- Shots ---
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();

  /** Our predicted shot: effects now, and a faint "predicted" hit marker if we saw a hit. */
  function ownShot(shot: ShotRequest): void {
    const spec = simCtx.loadout[shot.slot];
    viewmodel.onShot();
    audio.shot(spec.def.class);
    const eye = eyePosition(predictor.state.move, moveCtx);
    const range = spec.def.maxRange;
    viewmodel.muzzleWorld(shot.slot, tmpB);
    let playerHit = false;
    // Visual spread guess, one ray per pellet (the server rolls the real ones).
    const cone = shot.spread + spec.pelletSpread;
    for (let i = 0; i < spec.pellets; i++) {
      const r = cone * Math.sqrt(Math.random());
      const th = Math.random() * Math.PI * 2;
      const d = directionFromAngles(
        (shot.yaw + Math.round(r * Math.cos(th))) & 0xffff,
        shot.pitch + Math.round(r * Math.sin(th)),
      );
      tmpDir.set(d[0], d[1], d[2]);
      tmpA.set(eye[0], eye[1], eye[2]);
      const wall = effects.castMap(tmpA, tmpDir, range);
      const wallDist = wall?.distance ?? range;
      let pelletHit = false;
      for (const pose of remotePoses.values()) {
        if (!pose.alive || pose.team === myTeam()) continue;
        if (rayPlayer(eye, d, pose.position, pose.crouching, movement, wallDist)) pelletHit = true;
      }
      playerHit ||= pelletHit;
      if (wall && !pelletHit) effects.impact(wall);
      effects.tracer(tmpB, tmpA.clone().addScaledVector(tmpDir, Math.min(wallDist, 80)));
    }
    if (playerHit && performance.now() - hud.hitAt > 120) {
      hud.hitAt = performance.now();
      hud.hitKind = 'predicted';
      hudDirty = true;
    }
  }

  function remoteFired(id: number, weapon: number): void {
    const pose = remotePoses.get(id);
    if (!pose) return;
    const def = weaponCatalog[weapon];
    const h = capsuleHeight(movement, pose.crouching);
    tmpA.set(
      pose.position[0],
      pose.position[1] + SKIN + h - movement.eyeOffset - 0.15,
      pose.position[2],
    );
    const cp = Math.cos(pose.pitch);
    tmpDir.set(-Math.sin(pose.yaw) * cp, Math.sin(pose.pitch), -Math.cos(pose.yaw) * cp);
    effects.muzzleFlash(tmpA.clone().addScaledVector(tmpDir, 0.5));
    const wall = effects.castMap(tmpA, tmpDir, 80);
    effects.tracer(
      tmpA.clone().addScaledVector(tmpDir, 0.5),
      tmpA.clone().addScaledVector(tmpDir, wall?.distance ?? 80),
    );
    audio.shot(def?.class ?? 'rifle', [tmpA.x, tmpA.y, tmpA.z]);
  }

  const aimDir = new THREE.Vector3();
  /** Crosshair turns red over a visible enemy; teammates get name tags. */
  function updateAimAndTags(): void {
    camera.getWorldDirection(aimDir);
    const eye: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const dir: [number, number, number] = [aimDir.x, aimDir.y, aimDir.z];
    const wall = effects.castMap(camera.position, aimDir, 150)?.distance ?? 150;
    let onEnemy = false;
    const tags = new Map<number, { name: string; head: THREE.Vector3 | null }>();
    for (const [id, pose] of remotePoses) {
      if (!pose.alive) continue;
      if (pose.team === myTeam()) {
        tags.set(id, { name: nameOf(id), head: remotePlayers.headOf(id, new THREE.Vector3()) });
      } else if (
        !onEnemy &&
        rayPlayer(eye, dir, pose.position, pose.crouching, movement, wall) &&
        !grenadeView.smokeBlocks(eye, pose.position)
      ) {
        onEnemy = true; // (never through smoke: the red crosshair must not reveal hidden enemies)
      }
    }
    document.body.classList.toggle('aim-enemy', onEnemy && hud.alive);
    feedback.setTags(camera, tags);
  }

  // --- Frame loop ---
  const timer = new THREE.Timer();
  let accumulator = 0;
  let eyeHeight = eyeHeightFor(predictor.state.move.crouching);
  let bobPhase = 0;
  let lastHud = 0;
  let frames = 0;
  let lastSlot = 0;
  let lastReload = 0;

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const frame = timer.getDelta();
    frames++;

    const serverNow = clock.now(performance.now());
    const viewTick = serverNow === null ? 0 : Math.max(0, serverNow - interpDelay.ticks);

    // Run slightly faster/slower to keep ~2 inputs queued on the server (online only).
    const pace = spawnedFromServer ? inputPacing(queueDepth) : 1;
    const fixed = advanceFixedStep(accumulator, frame * pace);
    accumulator = fixed.accumulator;
    for (let i = 0; i < fixed.ticks; i++) {
      prevState = predictor.state;
      const sample = input.sample();
      // Frozen (countdown/results) or dead: the server doesn't step us, so neither do we.
      const skip = spawnedFromServer && (frozen || !hud.alive || awaitingSpawn);
      const { shot } = predictor.tick(
        { ...sample, weaponSlot: sample.weaponSlot ?? 0, viewTick },
        { skip },
      );
      if (shot && hud.alive) ownShot(shot);
      if (conn.connected && spawnedFromServer) {
        conn.sendInput({ ackServerTick: latestServerTick, inputs: predictor.recentInputs() });
      }
      if (!spawnedFromServer && predictor.state.move.position[1] < map.killY) {
        predictor.reset(freshSim());
        prevState = predictor.state;
      }
    }
    predictor.decayOffset(frame);

    // Own player: interpolate between the last two ticks, plus any correction still blending out.
    const a = fixed.alpha;
    const s = predictor.state;
    const m = s.move;
    const off = predictor.renderOffset;
    const px = lerp(prevState.move.position[0], m.position[0], a) + off[0];
    const py = lerp(prevState.move.position[1], m.position[1], a) + off[1];
    const pz = lerp(prevState.move.position[2], m.position[2], a) + off[2];

    // Ease the eye between standing and crouching height (~0.1 s) instead of popping.
    eyeHeight += (eyeHeightFor(m.crouching) - eyeHeight) * Math.min(1, frame * 15);
    const speed = Math.hypot(m.velocity[0], m.velocity[2]);
    let bob = 0;
    if (settings().headBob && m.grounded && speed > 0.5) {
      bobPhase += frame * speed * 1.8;
      bob = Math.sin(bobPhase) * 0.03;
    }
    camera.position.set(px, py + eyeHeight + bob, pz);
    // Mouse look every frame from the live look angles (no input lag), plus weapon recoil.
    const w = s.weapon;
    camera.rotation.set(
      input.look.pitch + w.recoilPitch * RAD_PER_UNIT,
      input.look.yaw + w.recoilYaw * RAD_PER_UNIT,
      0,
    );
    syncLoadout();
    applyGraphics();
    const spec = simCtx.loadout[w.slot];
    const ads = adsFraction(w, spec);
    // Aiming zooms in a little (a marksman scope a lot more).
    const zoom = spec.def.class === 'marksman' ? 0.45 : 0.18;
    const vfov = verticalFovDegrees(settings().fov * (1 - zoom * ads), camera.aspect);
    if (Math.abs(camera.fov - vfov) > 0.01) {
      camera.fov = vfov;
      camera.updateProjectionMatrix();
    }
    viewmodel.root.visible = hud.alive;
    viewmodel.update(frame, {
      slot: w.slot,
      ads,
      reloading: w.reloadTicks > 0 ? Math.sin((1 - w.reloadTicks / spec.reloadTicks) * Math.PI) : 0,
      switching: w.switchTicks / spec.equipTicks,
      speed,
      grounded: m.grounded,
    });
    audio.setListener(camera.position.x, camera.position.y, camera.position.z, input.look.yaw);
    if (w.slot !== lastSlot || (w.reloadTicks > 0 && lastReload === 0)) audio.click();
    lastSlot = w.slot;
    lastReload = w.reloadTicks;

    // Crosshair gap from the current spread (pixels on screen).
    const moveInfo = { moving: speed > 1, airborne: !m.grounded, sprinting: false };
    const spreadRad = (currentSpread(w, spec, moveInfo) / UNITS_PER_DEGREE) * (Math.PI / 180);
    const pxPerRad = window.innerHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
    document.documentElement.style.setProperty(
      '--spread',
      `${Math.round(4 + spreadRad * pxPerRad)}px`,
    );

    // Remote players: drawn in the past, between two snapshots we already have.
    if (serverNow !== null) {
      const renderTick = serverNow - interpDelay.ticks;
      for (const [id, buf] of remoteBuffers) {
        const pose = buf.sample(renderTick);
        if (!pose) continue;
        remotePoses.set(id, pose);
        remotePlayers.update(id, pose, frame);
      }
      grenadeView.update(renderTick, performance.now());
    }
    updateAimAndTags();
    feedback.update(camera, frame);
    effects.update(frame);
    renderer.render(scene, camera);

    // HUD values that change every frame: ammo/reload. Push to the store only when changed.
    const mag = w.ammo[w.slot];
    const reloading = w.reloadTicks > 0;
    if (
      mag.ammo !== hud.ammo ||
      mag.reserve !== hud.reserve ||
      reloading !== hud.reloading ||
      spec.def.name !== hud.weaponName
    ) {
      hud.ammo = mag.ammo;
      hud.reserve = mag.reserve;
      hud.reloading = reloading;
      hud.weaponName = spec.def.name;
      hudDirty = true;
    }
    if (!hud.alive) hudDirty = true; // respawn countdown
    if (hudDirty) {
      hudDirty = false;
      setStatus({ combat: { ...hud } });
    }

    if (time - lastHud > 250) {
      const fps = (frames * 1000) / (time - lastHud || 1);
      frames = 0;
      lastHud = time;
      const st = predictor.stats;
      setStatus({
        fps,
        player: {
          position: m.position,
          speed,
          grounded: m.grounded,
          crouching: m.crouching,
          sliding: m.slideTicks > 0,
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

  return {
    backend,
    requestPlay: () => {
      audio.unlock();
      return input.requestLock();
    },
  };
}

function eyeHeightFor(crouching: boolean): number {
  return SKIN + capsuleHeight(movement, crouching) - movement.eyeOffset;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Ask for a WebGPU adapter, but give up after a moment: some browsers (and headless Chrome
 * with several tabs) never answer, which would leave the game stuck on a black screen.
 * No adapter in time → WebGL 2.
 */
async function webgpuAvailable(timeoutMs = 2000): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    return (await Promise.race([gpu.requestAdapter(), timeout])) != null;
  } catch {
    return false;
  }
}

/** Sky, fog and light per map lighting preset (map data picks one). */
const LIGHTING: Record<
  GameMap['lighting'],
  {
    sky: number;
    fogNear: number;
    fogFar: number;
    hemiSky: number;
    hemiGround: number;
    hemiIntensity: number;
    sun: number;
    sunIntensity: number;
    sunPosition: [number, number, number];
  }
> = {
  day: {
    sky: 0x8ec3ef,
    fogNear: 70,
    fogFar: 160,
    hemiSky: 0xe8f3ff,
    hemiGround: 0x5a5048,
    hemiIntensity: 1.7,
    sun: 0xfff4e0,
    sunIntensity: 2.6,
    sunPosition: [20, 40, 15],
  },
  dusk: {
    sky: 0xe39a6b,
    fogNear: 60,
    fogFar: 150,
    hemiSky: 0xffd2b0,
    hemiGround: 0x4a4050,
    hemiIntensity: 1.7,
    sun: 0xff9a5c,
    sunIntensity: 2.2,
    sunPosition: [35, 14, -20],
  },
};

/** Per preset: shadow map size (0 = no shadows) and the highest device pixel ratio used. */
const GRAPHICS: Record<GraphicsPreset, { shadowMapSize: number; maxPixelRatio: number }> = {
  low: { shadowMapSize: 0, maxPixelRatio: 1 },
  medium: { shadowMapSize: 1024, maxPixelRatio: 1.5 },
  high: { shadowMapSize: 2048, maxPixelRatio: 2 },
};
