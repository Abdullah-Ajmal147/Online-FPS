import * as THREE from 'three/webgpu';
import {
  MAP_ROTATION,
  modes,
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
  type ChatLine,
  type MatchInfo,
  type Snapshot,
} from '@sentinel/protocol';
import {
  Button,
  Predictor,
  SKIN,
  TICK_RATE,
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
import { gameAudio } from '../audio/index.ts';
import { verticalFovDegrees } from '../camera.ts';
import { InputCapture } from '../input/capture.ts';
import { buildMapMeshes } from '../map.ts';
import { Connection } from '../net.ts';
import { ServerClock, inputPacing, TARGET_QUEUE_DEPTH } from '@sentinel/shared';
import { InterpolationDelay, RemoteBuffer, type RemotePose } from '@sentinel/shared';
import { loadoutChoice, type GraphicsPreset, type Settings } from '../settings.ts';
import { ensureGuest, refreshProfile } from '../profile.ts';
import { isMuted, rememberRecentPlayers } from '../social.ts';
import { setStatus, type CombatHud, type KillFeedEntry, getStatus, chatBridge } from '../store.ts';
import { Effects } from './effects.ts';
import { advanceFixedStep } from './fixedStep.ts';
import { Feedback } from './feedback.ts';
import { RemotePlayers } from './remotePlayers.ts';
import { GrenadeView } from './grenadeView.ts';
import { PointMarkers } from './pointMarkers.ts';
import { Viewmodel } from './viewmodel.ts';
import { DEATH_PAUSE_MS, KillcamRecorder, type KillcamPlan } from './killcam.ts';

export interface Game {
  /**
   * Join a match (first DEPLOY), or create a private one. Resolves once the join was sent;
   * safe to call twice.
   */
  join(opts?: { private?: { map: string; bots: boolean } }): Promise<void>;
  /** Private matches: move to the other team. */
  switchTeam(): void;
  /** Back to the main menu: leave the match with a clean page. */
  leave(): void;
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
  // Shadows and anti-aliasing are fixed when the renderer starts (a preset change for these
  // applies after a reload; resolution applies live).
  const startQuality = GRAPHICS[settings().graphics];
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: startQuality.antialias,
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
  sun.castShadow = startQuality.shadowMapSize > 0;
  if (sun.castShadow)
    sun.shadow.mapSize.set(startQuality.shadowMapSize, startQuality.shadowMapSize);
  // Medium: the map's shadows are drawn once per map (the sun and the map don't move) instead
  // of every frame; only High redraws them each frame with soldiers in them. The per-frame
  // shadow pass was the biggest GPU cost on integrated graphics.
  sun.shadow.autoUpdate = startQuality.dynamicShadows;
  RemotePlayers.castShadows = startQuality.dynamicShadows;

  /**
   * Automatic resolution: when frames run slow for a couple of seconds (GPU busy), render
   * fewer pixels; raise them again when there is headroom. Changes at most every 2 s, since
   * resizing the canvas costs a frame itself. Multiplies the preset and the menu's scale.
   */
  let dynamicScale = 1;
  let slowWindows = 0;
  let fastWindows = 0;
  let windowFrames = 0;
  let windowMs = 0;
  let lastScaleChange = 0;
  function adaptResolution(frameMs: number, now: number): void {
    if (!settings().autoResolution) {
      dynamicScale = 1;
      return;
    }
    windowFrames++;
    windowMs += frameMs;
    if (windowMs < 1000) return;
    const avg = windowMs / windowFrames;
    windowFrames = 0;
    windowMs = 0;
    slowWindows = avg > 19 ? slowWindows + 1 : 0; // under ~52 fps
    fastWindows = avg < 15.5 ? fastWindows + 1 : 0; // steady 60+
    if (now - lastScaleChange < 2000) return;
    if (slowWindows >= 2 && dynamicScale > 0.6) {
      dynamicScale = Math.max(0.6, dynamicScale - 0.1);
      lastScaleChange = now;
      slowWindows = 0;
    } else if (fastWindows >= 5 && dynamicScale < 1) {
      dynamicScale = Math.min(1, dynamicScale + 0.05);
      lastScaleChange = now;
      fastWindows = 0;
    }
  }

  /** Resolution (preset pixel-ratio cap × render scale), applied live when the menu changes. */
  let appliedGraphics = '';
  function applyGraphics(): void {
    const { graphics } = settings();
    const renderScale = settings().renderScale * dynamicScale;
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
  const audio = gameAudio;
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
  const pointMarkers = new PointMarkers(scene);
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
    pointMarkers.setMap(map, modes['domination']?.capture?.radius ?? 4);
    applyLighting(map.lighting);
    sun.shadow.needsUpdate = true; // static shadows: draw the new map's once
    setStatus({ mapName: map.name, mapId: map.id });
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

  // Main-menu backdrop until we join: the first map of the rotation, seen from above.
  loadMap(MAP_ROTATION[0] ?? 'relay-yard');
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
    killcam: null,
    hitAt: -Infinity,
    hitKind: 'hit',
    confirmedHits: 0,
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

  const codes = new Map<number, string>();
  let chatKey = 0;
  const onChat = (line: ChatLine) => {
    const code = codes.get(line.from);
    const muteKey = code ? code : `id:${line.from}`;
    if (isMuted(muteKey)) return;
    const entry = {
      key: chatKey++,
      name: nameOf(line.from),
      team: line.from === myId ? myTeam() : (teamOf.get(line.from) ?? 0),
      teamOnly: line.team,
      text: line.text,
      at: performance.now(),
      muteKey,
    };
    setStatus({ chat: [...getStatus().chat.slice(-29), entry] });
  };
  chatBridge.send = (team, text) => conn.sendChat(team, text);
  chatBridge.opened = () => input.releaseAll();

  const PHASES = ['warmup', 'countdown', 'live', 'ended'] as const;
  const pointOwners = new Map<string, number>();
  const onMatchInfo = (info: MatchInfo) => {
    for (const p of info.players) {
      names.set(p.id, p.name);
      teamOf.set(p.id, p.team);
      codes.set(p.id, p.code);
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
      // Humans you just played with (the menu's "Recent players"; add them as friends there).
      rememberRecentPlayers(info.players.filter((p) => !p.bot && p.id !== myId && p.code));
      audio.sting(info.winner === DRAW ? 'draw' : info.winner === myTeam() ? 'win' : 'loss');
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
    pointMarkers.update(info.points);
    // Domination: a node changed hands (not at the start of a match, when all reset).
    for (const p of info.points) {
      const before = pointOwners.get(p.id);
      if (
        before !== undefined &&
        before !== p.owner &&
        p.owner !== -1 &&
        info.phase === MatchPhase.Live
      )
        audio.capture(p.owner === mine);
      pointOwners.set(p.id, p.owner);
    }
    setStatus({
      match: {
        phase: PHASES[info.phase]!,
        secondsLeft: info.secondsLeft,
        scoreLimit: info.scoreLimit,
        scores: [info.teamScores[mine as 0 | 1], info.teamScores[(1 - mine) as 0 | 1]],
        myTeam: mine,
        mode: info.mode,
        private: info.private,
        points: info.points,
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
  /** Last few seconds of snapshots, for the killcam (see killcam.ts). */
  const killcamRec = new KillcamRecorder();
  /** Set when we're killed by someone: replay plan (null = death cam only) and who. */
  let killcam: {
    plan: KillcamPlan | null;
    startAt: number;
    killerId: number;
    weapon: string;
  } | null = null;
  addEventListener('keydown', (e) => {
    // Space skips the replay (back to the death view until respawn).
    if (e.code === 'Space' && killcam?.plan && performance.now() >= killcam.startAt)
      killcam.plan = null;
  });
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
        if (joining) setStatus({ spawned: true });
        lifeId = own.lifeId;
        awaitingSpawn = false;
        // Face the way the spawn point faces (not wherever we were looking when we died).
        const pos = own.sim.move.position;
        const spawn = map.spawns.find(
          (sp) => Math.hypot(sp.position[0] - pos[0], sp.position[2] - pos[2]) < 1.5,
        );
        if (spawn) input.look = { yaw: (spawn.yawDeg * Math.PI) / 180, pitch: 0 };
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
    // Killcam recording: everyone in this snapshot, plus our own soldier (the killer's view
    // should show us).
    if (own) {
      const m = own.sim.move;
      killcamRec.record(snap.serverTick, [
        ...snap.entities,
        {
          id: myId,
          team: myTeam(),
          alive: own.respawnTicks === 0,
          crouching: m.crouching,
          grounded: m.grounded,
          position: m.position,
          yaw: predictor.state.move.yaw, // own look is not in the snapshot: ours
          pitch: predictor.state.move.pitch,
          weapon: 255,
          shotCount: 0,
        },
      ]);
    } else killcamRec.record(snap.serverTick, snap.entities);
  };

  const onEvents = (events: GameEvent[]) => {
    for (const ev of events) {
      if (ev.type === 'hit') {
        hud.confirmedHits++;
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
        if (ev.victim === myId && ev.killer !== myId) {
          hud.killedBy = nameOf(ev.killer);
          killcam = {
            plan: settings().killcam ? killcamRec.plan(ev.killer, latestServerTick) : null,
            startAt: performance.now() + DEATH_PAUSE_MS,
            killerId: ev.killer,
            weapon: killSourceName(ev.weapon),
          };
        }
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
    setStatus({ spawned: false });
    latestServerTick = 0;
    remoteBuffers.clear();
    remotePoses.clear();
    remotePlayers.retain(new Set());
    hud.alive = true;
    hudDirty = true;
    frozen = false;
    setStatus({ match: null });
  };

  /**
   * Nothing is joined until the player presses DEPLOY: a player reading the menu must not
   * stand in a live match (or take a team's slot).
   */
  let joined = false;
  let joining: Promise<void> | null = null;
  const join = (opts?: { private?: { map: string; bots: boolean } }) =>
    (joining ??= (async () => {
      setStatus({ net: { state: 'connecting', text: 'connecting…' }, inMatch: true });
      const guest = await ensureGuest(); // signed guest token (XP); the game works without it
      joined = true;
      await joinMatch(guest?.token ?? null, opts?.private);
    })());
  const joinMatch = (token: string | null, privateMatch?: { map: string; bots: boolean }) =>
    conn.connect(
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
        onChat,
        onDisconnect,
      },
      {
        name: settings().name,
        token,
        loadout: loadoutChoice(settings()),
        mode: settings().mode,
        region: settings().region,
        allowJoin: settings().allowJoin,
        private: privateMatch,
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
  /**
   * Other players' footsteps, placed where they walk: how far they moved since last frame.
   * Crouch-walking is nearly silent (a real tactic). Enemies are only in our snapshots when
   * near or visible (ADR 0009), which is also roughly when you could hear them.
   */
  function remoteFootsteps(id: number, pose: RemotePose, frame: number): void {
    const [x, y, z] = pose.position;
    const last = remoteSteps.get(id);
    if (!last || !pose.alive) {
      remoteSteps.set(id, { x, y, z, walked: 0 });
      return;
    }
    const d = Math.hypot(x - last.x, z - last.z);
    const onGround = Math.abs(y - last.y) < 0.02;
    last.x = x;
    last.y = y;
    last.z = z;
    // A teleport (respawn) or standing still: no steps.
    if (d > 2 || d < 0.001 || !onGround || frame <= 0) return;
    last.walked += d;
    const speed = d / frame;
    const length = pose.crouching ? 1.3 : speed > movement.walkSpeed + 0.5 ? 2.3 : 1.9;
    if (last.walked >= length) {
      last.walked = 0;
      const loud = pose.crouching ? 0.12 : Math.min(1, speed / movement.sprintSpeed);
      audio.footstep(loud, [x, y, z]);
    }
  }

  /**
   * After our death: 0.5 s on the death view, then the killcam replay from the killer's eyes
   * (if we saw enough of them), else the camera turns toward the killer. Returns true while
   * the replay is drawing the players (the live remote update is skipped then).
   */
  function updateKillcam(frame: number): boolean {
    if (killcam && hud.alive) killcam = null; // respawned
    let replaying = false;
    if (killcam) {
      const now = performance.now();
      const plan = killcam.plan;
      const tick = plan ? plan.startTick + ((now - killcam.startAt) / 1000) * TICK_RATE : 0;
      if (plan && tick > plan.endTick) killcam.plan = null;
      if (plan && killcam.plan && now >= killcam.startAt) {
        const poses = plan.posesAt(tick);
        const k = poses.get(plan.killerId);
        if (k) {
          camera.position.set(
            k.position[0],
            k.position[1] + eyeHeightFor(k.crouching),
            k.position[2],
          );
          camera.rotation.set(k.pitch, k.yaw, 0);
        }
        for (const [id, pose] of poses) remotePlayers.update(id, pose, frame);
        remotePlayers.hide(plan.killerId); // we are looking out of their eyes
        replaying = true;
      } else {
        // Death cam: turn toward the killer (where we last saw them).
        const target = remotePoses.get(killcam.killerId)?.position;
        if (target) {
          const dx = target[0] - camera.position.x;
          const dy = target[1] + 1.4 - camera.position.y;
          const dz = target[2] - camera.position.z;
          const yaw = Math.atan2(-dx, -dz);
          const pitch = Math.atan2(dy, Math.hypot(dx, dz));
          let dYaw = yaw - input.look.yaw;
          dYaw -= Math.round(dYaw / (2 * Math.PI)) * 2 * Math.PI;
          const k = Math.min(1, frame * 5);
          input.look = {
            yaw: input.look.yaw + dYaw * k,
            pitch: input.look.pitch + (pitch - input.look.pitch) * k,
          };
          camera.rotation.set(input.look.pitch, input.look.yaw, 0);
        }
      }
    }
    const banner =
      replaying && killcam ? { killer: nameOf(killcam.killerId), weapon: killcam.weapon } : null;
    if ((banner === null) !== (hud.killcam === null)) {
      hud.killcam = banner;
      hudDirty = true;
    }
    return replaying;
  }

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
  let fireWasDown = false;
  /** Metres walked since the last footstep (own). */
  let stride = 0;
  /** Remote players' last drawn position and distance walked, for their footsteps. */
  const remoteSteps = new Map<number, { x: number; y: number; z: number; walked: number }>();
  let lastReload = 0;

  let orbit = 0;
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const frame = timer.getDelta();
    // A long gap (tab in the background) says nothing about the GPU.
    if (frame < 0.25) adaptResolution(frame * 1000, performance.now());
    frames++;

    if (!joined) {
      // Main menu: a slow flyover of the map behind the menu. No input, no simulation.
      orbit += frame * 0.045;
      camera.position.set(
        Math.sin(orbit) * 30,
        17 + Math.sin(orbit * 0.7) * 2,
        Math.cos(orbit) * 30,
      );
      camera.lookAt(0, 1, 0);
      viewmodel.root.visible = false;
      effects.update(frame);
      renderer.render(scene, camera);
      return;
    }

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
      // Dry fire: trigger pulled on an empty magazine (once per pull).
      const firing = (sample.buttons & Button.Fire) !== 0;
      const wpn = predictor.state.weapon;
      if (firing && !fireWasDown && hud.alive && !frozen && wpn.ammo[wpn.slot].ammo === 0)
        audio.dryFire();
      fireWasDown = firing;
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
    const replaying = updateKillcam(frame);
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
    if (w.slot !== lastSlot) audio.click();
    else if (w.reloadTicks > 0 && lastReload === 0) audio.reload(w.reloadTicks / TICK_RATE);
    // Own footsteps: a step every ~1.9 m (longer strides sprinting, short and soft crouched).
    if (hud.alive && m.grounded && speed > 1.2 && !replaying) {
      stride += speed * frame;
      const sprinting = speed > movement.walkSpeed + 0.5;
      const length = m.crouching ? 1.3 : sprinting ? 2.3 : 1.9;
      if (stride >= length) {
        stride = 0;
        audio.footstep(m.crouching ? 0.08 : sprinting ? 0.4 : 0.28);
      }
    }
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
    if (serverNow !== null && !replaying) {
      const renderTick = serverNow - interpDelay.ticks;
      for (const [id, buf] of remoteBuffers) {
        const pose = buf.sample(renderTick);
        if (!pose) continue;
        remotePoses.set(id, pose);
        remotePlayers.update(id, pose, frame);
        remoteFootsteps(id, pose, frame);
      }
      grenadeView.update(renderTick, performance.now());
    }
    if (!replaying) updateAimAndTags();
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
    join,
    leave: () => {
      // A fresh page is the cleanest way out: no half-torn-down match state survives.
      const url = new URL(location.href);
      url.searchParams.delete('room');
      url.searchParams.delete('with');
      location.assign(url.toString());
    },
    switchTeam: () => conn.switchTeam(),
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

/**
 * Per preset: shadow map size (0 = no shadows), whether shadows are redrawn every frame (with
 * soldiers), MSAA, and the highest device pixel ratio used.
 */
const GRAPHICS: Record<
  GraphicsPreset,
  { shadowMapSize: number; dynamicShadows: boolean; antialias: boolean; maxPixelRatio: number }
> = {
  low: { shadowMapSize: 0, dynamicShadows: false, antialias: false, maxPixelRatio: 1 },
  medium: { shadowMapSize: 1024, dynamicShadows: false, antialias: true, maxPixelRatio: 1.5 },
  high: { shadowMapSize: 2048, dynamicShadows: true, antialias: true, maxPixelRatio: 2 },
};
