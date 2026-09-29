import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { Post, type Grade, type Haze } from './post.ts';
import {
  MAP_ROTATION,
  modes,
  defaultLoadout,
  killSourceName,
  maps,
  movement,
  streakRewards,
  weaponCatalog,
  buildLoadout,
  kickFor,
  melee as meleeTuning,
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
  type AwardKind,
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
  scopeSway,
  directionFromAngles,
  expandMap,
  type Solid,
  eyePosition,
  eyeHeight as eyeHeightOf,
  initPhysics,
  rayPlayer,
  yawFromDegrees,
  yawFromRadians,
  yawToRadians,
  type MovementContext,
  type ShotRequest,
  type SimContext,
  type SimState,
} from '@sentinel/shared';
import { gameAudio } from '../audio/index.ts';
import { verticalFovDegrees, zoomedFovDegrees } from '../camera.ts';
import { enterGameFullscreen, setLeaveGuard } from '../input/shortcutGuard.ts';
import { Minimap } from './minimap.ts';
import { Dust } from './dust.ts';
import { Glints } from './glints.ts';
import { viewerTeam } from './soldier/rim.ts';
import { InputCapture } from '../input/capture.ts';
import { buildMapMeshes, loadSurfaces, themeOf, type Surfaces, type Theme } from '../map.ts';
import { Connection } from '../net.ts';
import { ServerClock, inputPacing, TARGET_QUEUE_DEPTH } from '@sentinel/shared';
import { InterpolationDelay, RemoteBuffer, type RemotePose } from '@sentinel/shared';
import { keyLabel, loadoutChoice, type GraphicsPreset, type Settings } from '../settings.ts';
import { ensureGuest, refreshProfile } from '../profile.ts';
import { isMuted, rememberRecentPlayers } from '../social.ts';
import {
  setStatus,
  type CombatHud,
  type KillFeedEntry,
  getStatus,
  chatBridge,
  voteBridge,
} from '../store.ts';
import { Effects, type MapHit } from './effects.ts';
import { surfaceKind, type SurfaceKind } from './surfaceKinds.ts';
import { devStats, tuning } from './tuning.ts';
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

/** Titles and value text of the end-of-match awards. */
const AWARD_TEXT: Record<AwardKind, (v: number) => { title: string; value: string }> = {
  headshots: (v) => ({ title: 'Sharpshooter', value: `${v} headshots` }),
  streak: (v) => ({ title: 'Unstoppable', value: `${v} kills without dying` }),
  longest: (v) => ({ title: 'Long shot', value: `${v} m kill` }),
  captures: (v) => ({ title: 'Objective', value: `${v} ${v === 1 ? 'capture' : 'captures'}` }),
  frags: (v) => ({ title: 'Grenadier', value: `${v} frag ${v === 1 ? 'kill' : 'kills'}` }),
};
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
  // Filmic tone mapping: bright sun and sky roll off like a real camera instead of clipping.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  await renderer.init();
  // Draw calls and triangles are counted over a whole frame (the post pass renders several
  // times per frame), reset by the frame loop; the F1 panel shows them.
  renderer.info.autoReset = false;
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  console.info(`[renderer] backend: ${backend}`);
  devStats.backend = backend;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8ec3ef);
  scene.fog = new THREE.Fog(0x8ec3ef, 70, 160);
  const hemi = new THREE.HemisphereLight(0xe8f3ff, 0x5a5048, 1.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  sun.position.set(20, 40, 15);
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, far: 140 });
  scene.add(sun);
  // A real sky: sun, atmospheric haze and clouds, drawn at the far plane (always behind the map).
  const sky = new SkyMesh();
  sky.scale.setScalar(200);
  sky.frustumCulled = false;
  scene.add(sky);

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
  /** Pre-filtered sky light (see bakeSkyLight below); null until the first map is lit. */
  let skyLight: THREE.RenderTarget | null = null;
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
    applySkyLight();
  }

  applyGraphics();

  // Sniper scope view (shown while a marksman rifle is fully aimed; style.css .scope-overlay).
  const scopeEl = document.createElement('div');
  scopeEl.className = 'scope-overlay';
  scopeEl.dataset.testid = 'scope';
  canvas.after(scopeEl); // over the 3D view, under the HUD (health, ammo stay readable)
  // Zoom level while aiming ("2×"), just under the crosshair.
  // Hold-breath meter inside the scope view.
  const breathEl = document.createElement('div');
  breathEl.className = 'scope-breath';
  breathEl.dataset.testid = 'scope-breath';
  breathEl.append(document.createElement('span'), document.createElement('b'));
  scopeEl.append(breathEl);
  const zoomEl = document.createElement('div');
  zoomEl.className = 'zoom-level';
  zoomEl.dataset.testid = 'zoom-level';
  scopeEl.after(zoomEl);
  const minimap = new Minimap(zoomEl);
  /** Capture points as the last MatchInfo had them (minimap colours). */
  let objectives: { id: string; owner: number }[] = [];
  /** Armor streak reward: until when (performance.now), as the server granted it. */
  let armorUntil = -Infinity;
  /** Camera feel: shake (explosions, hits, shots; decays fast) and the landing dip. */
  let shake = 0;
  const kick = (amount: number) => (shake = Math.min(2, shake + amount));
  let landDip = 0;
  let lastLookYaw = 0;
  /** Last hit we took (the red edge pulse). */
  let hurtAt = -Infinity;
  const hurtEl = document.createElement('div');
  hurtEl.className = 'hurt-overlay';
  hurtEl.dataset.testid = 'hurt';
  zoomEl.after(hurtEl);
  let lastLookPitch = 0;
  let wasGrounded = true;
  let lastVy = 0;
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  /** Chosen zoom level per weapon slot (index into the weapon's zoomLevels). */
  const zoomIndex: [number, number] = [0, 0];

  const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 250);
  camera.rotation.order = 'YXZ'; // yaw first, then pitch: no roll creeping in
  scene.add(camera); // the viewmodel hangs off the camera

  // Medium/High: the scene goes through Post (grading; High adds ambient occlusion and bloom).
  // Built when first needed and rebuilt when the preset changes; Low draws straight out.
  let post: Post | null = null;
  let postPreset: string | null = null;
  function draw(): void {
    sky.position.copy(camera.position);
    const preset = settings().graphics;
    post?.updateSun();
    const q = GRAPHICS[preset];
    if (!q.post) {
      renderer.render(scene, camera);
      return;
    }
    if (!post || postPreset !== preset) {
      post?.dispose();
      post = new Post(renderer, scene, camera, {
        ambientOcclusion: q.ambientOcclusion,
        bloom: q.bloom,
        sunShafts: q.sunShafts,
      });
      post.setHaze(HAZE[map?.lighting ?? 'day'], sun.position);
      postPreset = preset;
      post.setGrade(tuning.grade ?? LOOKS[map?.lighting ?? 'day']);
    }
    post.render();
  }
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
  const effects = new Effects(scene, GRAPHICS[settings().graphics].post);
  const grenadeView = new GrenadeView(scene);
  const dust = new Dust(scene);
  const glints = new Glints(scene);
  const lensAt = new THREE.Vector3();
  const pointMarkers = new PointMarkers(scene);
  const freshSim = (): SimState => {
    const spawn = map.spawns[0]!;
    return {
      move: createPlayerState(spawn.position, yawFromDegrees(spawn.yawDeg)),
      weapon: createWeaponState(simCtx.loadout),
    };
  };
  // Real map surfaces (per map theme) load in the background; until a map's are here it is
  // drawn in flat colours, then redrawn once (in the menu, before any match: no mid-fight hitch).
  const surfacesByTheme = new Map<Theme, Surfaces>();
  let mapSolids: Solid[] = [];
  function showMap(): void {
    if (mapMeshes) {
      scene.remove(mapMeshes);
      mapMeshes.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    const theme = themeOf(map.id);
    mapMeshes = buildMapMeshes(mapSolids, surfacesByTheme.get(theme), theme);
    scene.add(mapMeshes);
    sun.shadow.needsUpdate = true; // static shadows: draw the new map's once
    if (!surfacesByTheme.has(theme) && !surfaceLoads.has(theme)) {
      const load = loadSurfaces(theme)
        .then(async (s) => {
          // Set the materials up off the main path before they are first drawn.
          const onePerMaterial = mapSolids.filter(
            (x, i, all) => all.findIndex((y) => y.material === x.material) === i,
          );
          await renderer
            .compileAsync(buildMapMeshes(onePerMaterial, s, theme), camera, scene)
            .catch(() => undefined);
          surfacesByTheme.set(theme, s);
          if (themeOf(map.id) === theme) showMap();
        })
        .catch((e: unknown) => console.warn('[map] surface textures unavailable, flat colours', e));
      surfaceLoads.set(theme, load);
    }
  }
  /** Map surface textures being loaded, per theme (the world-ready step waits for them). */
  const surfaceLoads = new Map<string, Promise<void>>();

  /**
   * World ready (after joining or a map change): compile everything the first frames will
   * draw — the map with its textures, the soldier models, the pooled effects, the post pass —
   * asynchronously, behind the deploy card, instead of synchronously on the first frames of
   * play (measured: 1.5–2.3 s stalls in the first seconds after spawning). The 3D view isn't
   * drawn meanwhile (drawing would compile the slow way). At most ~6 s: never stuck.
   */
  let worldReady = true;
  let worldToken = 0;
  function prepareWorld(): void {
    const token = ++worldToken;
    worldReady = false;
    setStatus({ worldReady: false });
    const within = (p: Promise<unknown>, ms: number) =>
      Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
    void (async () => {
      await within(
        Promise.all([surfaceLoads.get(themeOf(map.id)) ?? null, remotePlayers.ready]),
        4000,
      );
      effects.showPoolsForCompile(true);
      await within(renderer.compileAsync(scene, camera, scene), 2500);
      effects.showPoolsForCompile(false);
      if (token !== worldToken) return; // a newer map change took over
      draw(); // first draw, under the card: the post pass sets itself up here
      worldReady = true;
      setStatus({ worldReady: true });
    })();
  }
  // Visual ray casts against the map (effects, crosshair): the physics world, reused objects.
  const mapHit: MapHit = {
    surface: 'concrete',
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
  };
  /** What each map collider is made of (by collider handle), for impacts and footsteps. */
  const surfaceOf = new Map<number, SurfaceKind>();
  const mapRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  function loadMap(id: string): void {
    const next = maps[id];
    if (!next) throw new Error(`unknown map "${id}"`);
    map = next;
    const solids = expandMap(map);
    mapSolids = solids;
    minimap.setMap(solids, map.points);
    const oldWorld = moveCtx?.world;
    showMap();
    grenadeView.clear();
    pointMarkers.setMap(map, modes['domination']?.capture?.radius ?? 4);
    applyLighting(map.lighting);
    sun.shadow.needsUpdate = true; // static shadows: draw the new map's once
    setStatus({ mapName: map.name, mapId: map.id });
    surfaceOf.clear();
    const theme = themeOf(map.id);
    const physicsWorld = buildWorld(rapier, solids, (handle, solid) =>
      surfaceOf.set(handle, surfaceKind(theme, solid.material)),
    );
    moveCtx = createMovementContext(rapier, physicsWorld, movement);
    const world = moveCtx.world;
    effects.setRaycast((origin, dir, max) => {
      mapRay.origin.x = origin.x;
      mapRay.origin.y = origin.y;
      mapRay.origin.z = origin.z;
      mapRay.dir.x = dir.x;
      mapRay.dir.y = dir.y;
      mapRay.dir.z = dir.z;
      const hit = world.castRayAndGetNormal(
        mapRay,
        max,
        true,
        rapier.QueryFilterFlags.EXCLUDE_SENSORS,
      );
      if (!hit) return null;
      mapHit.surface = surfaceOf.get(hit.collider.handle) ?? 'concrete';
      mapHit.distance = hit.timeOfImpact;
      mapHit.point.copy(origin).addScaledVector(dir, hit.timeOfImpact);
      mapHit.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      return mapHit;
    });
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
    sky.sunPosition.value.set(...l.sunPosition).normalize();
    sky.turbidity.value = l.turbidity;
    sky.rayleigh.value = l.rayleigh;
    sky.cloudCoverage.value = l.clouds;
    tuning.mapGrade = LOOKS[preset];
    post?.setHaze(HAZE[preset], sun.position);
    post?.setGrade(tuning.grade ?? LOOKS[preset]);
    bakeSkyLight();
  }

  /** Sky light on Medium/High (it costs a little on every lit pixel); Low keeps flat fill. */
  function applySkyLight(): void {
    if (!skyLight) return; // not baked yet (this also runs at start-up, before any map)
    const on = GRAPHICS[settings().graphics].skyLight;
    scene.environment = on ? skyLight.texture : null;
    hemi.intensity = LIGHTING[map.lighting].hemiIntensity * (on ? HEMI_UNDER_SKY_LIGHT : 1);
  }

  // Light from the sky: the sky (without its sun disc: no hard hot spots) rendered once into a
  // pre-filtered environment map. Metal reflects it and every surface gets the sky's own
  // colour as ambient light; the flat hemisphere light only fills in under it.
  const pmrem = new THREE.PMREMGenerator(renderer);
  function bakeSkyLight(): void {
    const skyScene = new THREE.Scene();
    const s = new SkyMesh();
    s.scale.setScalar(50);
    for (const k of [
      'turbidity',
      'rayleigh',
      'mieCoefficient',
      'mieDirectionalG',
      'cloudCoverage',
    ] as const)
      s[k].value = sky[k].value;
    s.sunPosition.value.copy(sky.sunPosition.value);
    s.showSunDisc.value = 0;
    skyScene.add(s);
    try {
      const next = pmrem.fromScene(skyScene, 0.02);
      skyLight?.dispose();
      skyLight = next;
      scene.environmentIntensity = SKY_LIGHT;
      applySkyLight();
    } catch (e) {
      console.warn('[lighting] sky light unavailable', e);
    }
    s.geometry.dispose();
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
    armorSeconds: 0,
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
  /** Our map vote this results screen (null: not voted; reset when the vote closes). */
  let myVote: number | null = null;
  voteBridge.vote = (option) => {
    myVote = option;
    conn.voteMap(option);
    const m = getStatus().match;
    if (m?.vote) setStatus({ match: { ...m, vote: { ...m.vote, mine: option } } });
  };
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
    if (!info.vote) myVote = null; // the vote closed with the results screen
    pointMarkers.update(info.points);
    objectives = info.points;
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
        vote: info.vote
          ? {
              options: info.vote.options.map((id, i) => ({
                id,
                name: maps[id]?.name ?? id,
                votes: info.vote!.counts[i] ?? 0,
              })),
              mine: myVote,
            }
          : null,
        awards: info.awards.map((a) => ({
          kind: a.kind,
          ...AWARD_TEXT[a.kind](a.value),
          name: info.players.find((p) => p.id === a.player)?.name ?? '?',
          me: a.player === myId,
        })),
        players: info.players.map((p) => ({ ...p, me: p.id === myId })),
      },
    });
  };

  // --- Network ---
  const conn = new Connection();
  const clock = new ServerClock();
  const interpDelay = new InterpolationDelay();
  const remoteBuffers = new Map<number, RemoteBuffer>();
  const remotePlayers = new RemotePlayers(scene, renderer, camera);
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
      /** Feed server events as if they arrived (kill-streak reward and radar tests). */
      events: (events: GameEvent[]) => onEvents(events),
      myId: () => myId,
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
      remotePlayers.setWeapon(e.id, weaponCatalog[e.weapon]);
      // A remote player fired since the last snapshot: muzzle flash, tracer, 3D sound.
      const lastShots = remoteShots.get(e.id);
      if (lastShots !== undefined && lastShots !== e.shotCount && e.alive) {
        remoteFired(e.id, e.weapon);
        // Gunfire gives an enemy away on the minimap, where they fired from.
        if (e.team !== myTeam()) minimap.enemyFired(e.id, e.position[0], e.position[2]);
      }
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
          prone: m.prone,
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
        kick(0.5); // taking a hit jolts the view
        hurtAt = performance.now();
      } else if (ev.type === 'reward') {
        // Kill-streak reward: the server already applied it (ammo, armor); we show it.
        const reward = streakRewards[ev.reward];
        if (reward && ev.player === myId) {
          announce('medal', reward.name.toUpperCase(), `${ev.streak} KILL STREAK`);
          if (reward.reward === 'armor')
            armorUntil = performance.now() + (reward.seconds ?? 0) * 1000;
        }
      } else if (ev.type === 'radar') {
        const seconds = streakRewards.find((s) => s.reward === 'radar')?.seconds ?? 5;
        minimap.sweep(ev.enemies, seconds);
        if (ev.by !== myId) announce('kill', 'RADAR SWEEP', `from ${nameOf(ev.by)}`);
      } else if (ev.type === 'explosion') {
        const [x, y, z] = ev.position;
        if (ev.kind === 'frag') {
          effects.explosion(new THREE.Vector3(x, y, z));
          // Nearby blasts shake the view (strong up close, nothing past ~20 m).
          const d = camera.position.distanceTo(tmpC.set(x, y, z));
          kick(Math.max(0, 1 - d / 20) * 1.6);
        }
        audio.explosion(ev.kind, ev.position);
      } else if (ev.type === 'kill') {
        minimap.forget(ev.victim);
        const victimPose = ev.victim === myId ? null : remotePoses.get(ev.victim);
        if (victimPose) effects.elimination(tmpC.set(...victimPose.position));
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
  /** When our last headshot kill landed (drives the short zoom punch and gold flash). */
  let headshotAt = -Infinity;
  /** When our last kill landed (a small view punch). */
  let killAt = -Infinity;
  function onMyKill(victim: string, headshot: boolean): void {
    const now = performance.now();
    if (headshot) {
      headshotAt = now;
      announce('medal', 'HEADSHOT');
      audio.headshotKill();
      document.body.classList.remove('headshot-flash');
      void document.body.offsetWidth; // restart the CSS animation
      document.body.classList.add('headshot-flash');
    }
    announce('kill', `ELIMINATED ${victim.toUpperCase()}`, headshot ? '+100 · HEADSHOT' : '+100');
    killAt = now;
    recentKills = [...recentKills.filter((t) => now - t < 4000), now];
    streak++;
    const multi = ['', '', 'DOUBLE KILL', 'TRIPLE KILL'][recentKills.length] ?? 'MULTI KILL';
    if (multi) announce('medal', multi);
    if (streak === 5) announce('medal', 'KILLING SPREE');
    if (streak === 10) announce('medal', 'UNSTOPPABLE');
  }

  let myTeamCache = 0;
  /** The world-ready step ran for this map (first join, then each map change). */
  let joinedWorld = false;
  let preparedMap = '';
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
      setLeaveGuard(true); // closing the tab mid-match asks first
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
          const problem = getStatus().inviteProblem;
          if (problem) {
            announce('medal', 'INVITE DID NOT WORK', problem);
            setTimeout(() => setStatus({ inviteProblem: null }), 8000);
          }
          if (!joinedWorld || hello.mapId !== preparedMap) {
            joinedWorld = true;
            preparedMap = hello.mapId;
            prepareWorld();
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
        map: settings().map,
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
  /** Our shots fired this session (every `tracerEvery`-th one is a tracer round). */
  let ownShots = 0;
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();

  /** Our predicted shot: effects now, and a faint "predicted" hit marker if we saw a hit. */
  function ownShot(shot: ShotRequest): void {
    const spec = simCtx.loadout[shot.slot];
    const f = tuning.feel;
    viewmodel.onShot(kickFor(f, spec.def), adsFraction(predictor.state.weapon, spec));
    // Tracer rounds: one in every `tracerEvery` (a shotgun shows a couple of its pellets).
    const tracerRound = ownShots++ % f.tracerEvery === 0;
    audio.shot(spec.def.class);
    const eye = eyePosition(predictor.state.move, moveCtx);
    const range = spec.def.maxRange;
    viewmodel.muzzleWorld(shot.slot, tmpB);
    effects.muzzleLight(tmpB);
    // A spent case from the ejection port (behind the muzzle, right side), flung right and up.
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    effects.casing(
      tmpC.copy(tmpB).lerp(camera.position, 0.55).addScaledVector(camRight, 0.035),
      camRight,
      camUp,
    );
    kick(f.shotShake); // a little shake on every shot
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
        const proneYaw = pose.prone ? yawFromRadians(pose.yaw) : undefined;
        if (rayPlayer(eye, d, pose.position, pose.crouching, movement, wallDist, proneYaw))
          pelletHit = true;
      }
      playerHit ||= pelletHit;
      if (wall && !pelletHit) {
        if (i === 0) audio.impact(wall.surface, [wall.point.x, wall.point.y, wall.point.z]);
        effects.impact(wall);
      }
      if (tracerRound && i < 2)
        effects.tracer(tmpB, tmpA.clone().addScaledVector(tmpDir, Math.min(wallDist, 120)));
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
    const h = capsuleHeight(movement, pose.crouching, pose.prone);
    tmpA.set(
      pose.position[0],
      pose.position[1] + SKIN + h - movement.eyeOffset - 0.15,
      pose.position[2],
    );
    const cp = Math.cos(pose.pitch);
    tmpDir.set(-Math.sin(pose.yaw) * cp, Math.sin(pose.pitch), -Math.cos(pose.yaw) * cp);
    // The shot goes where they look (from the eyes); the flash and tracer start at their gun.
    remotePlayers.fired(id);
    const muzzle =
      remotePlayers.muzzleOf(id, new THREE.Vector3()) ?? tmpA.clone().addScaledVector(tmpDir, 0.5);
    effects.muzzleFlash(muzzle);
    const wall = effects.castMap(tmpA, tmpDir, 80);
    effects.tracer(muzzle, tmpA.clone().addScaledVector(tmpDir, wall?.distance ?? 80));
    // Where their bullet lands (a guess from their view; the server decides hits): being shot
    // at should look like it, chips and dust off the wall next to you.
    if (wall) {
      audio.impact(wall.surface, [wall.point.x, wall.point.y, wall.point.z]);
      effects.impact(wall, true);
    }
    audio.shot(def?.class ?? 'rifle', [tmpA.x, tmpA.y, tmpA.z]);
  }

  const aimDir = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  /** What is under a player's feet (position = feet): footstep sounds. */
  function groundSurface(x: number, y: number, z: number): SurfaceKind {
    return effects.castMap(tmpA.set(x, y + 0.3, z), DOWN, 0.8)?.surface ?? 'concrete';
  }
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
      audio.footstep(loud, [x, y, z], groundSurface(x, y, z));
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
            k.position[1] + eyeHeightFor(k.crouching, k.prone),
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
        rayPlayer(
          eye,
          dir,
          pose.position,
          pose.crouching,
          movement,
          wall,
          pose.prone ? yawFromRadians(pose.yaw) : undefined,
        ) &&
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
  let eyeHeight = eyeHeightFor(predictor.state.move.crouching, predictor.state.move.prone);
  let bobPhase = 0;
  let lastHud = 0;
  let frames = 0;
  let lastSlot = 0;
  let fireWasDown = false;
  let meleeWasDown = false;
  let nextMeleeAt = 0;
  /** Metres walked since the last footstep (own). */
  let stride = 0;
  /** Remote players' last drawn position and distance walked, for their footsteps. */
  const remoteSteps = new Map<number, { x: number; y: number; z: number; walked: number }>();
  let lastReload = 0;

  let orbit = 0;
  /** Camera roll from strafing, and the sprint field-of-view widening (both eased). */
  let tilt = 0;
  let sprintFov = 0;
  let tuningVersion = -1;
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
      renderer.info.reset();
      draw();
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
      // Melee (V): the swing plays at once; the server decides whether it lands (hit event).
      const meleePressed = (sample.buttons & Button.Melee) !== 0 && !meleeWasDown;
      meleeWasDown = (sample.buttons & Button.Melee) !== 0;
      // (The server refuses a strike in the same moment as a shot: mirror that here.)
      if (
        meleePressed &&
        hud.alive &&
        !frozen &&
        performance.now() >= nextMeleeAt &&
        predictor.state.weapon.cooldownTicks === 0
      ) {
        nextMeleeAt = performance.now() + meleeTuning.cooldown * 1000;
        viewmodel.melee();
        audio.melee();
      }
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

    // Ease the eye between stances instead of popping: ~0.1 s for a crouch, slower (~0.4 s)
    // going down to or up from prone.
    const eyeTarget = eyeHeightFor(m.crouching, m.prone);
    const eyeRate = m.prone || eyeHeight < eyeHeightFor(true) - 0.05 ? 6 : 15;
    eyeHeight += (eyeTarget - eyeHeight) * Math.min(1, frame * eyeRate);
    const speed = Math.hypot(m.velocity[0], m.velocity[2]);
    let bob = 0;
    if (settings().headBob && m.grounded && speed > 0.5) {
      bobPhase += frame * speed * 1.8;
      bob = Math.sin(bobPhase) * 0.03;
    }
    // Landing: the view dips with the impact speed and springs back.
    if (m.grounded && !wasGrounded) landDip = Math.min(0.14, Math.max(0, -lastVy) * 0.018);
    wasGrounded = m.grounded;
    lastVy = m.velocity[1];
    landDip = Math.max(0, landDip - frame * 0.6);
    camera.position.set(px, py + eyeHeight + bob - landDip, pz);
    // Mouse look every frame from the live look angles (no input lag), plus weapon recoil and
    // camera shake (visual only: the shot direction comes from the look angles).
    const w = s.weapon;
    shake = Math.max(0, shake * Math.exp(-frame * 9) - frame * 0.02);
    const t = performance.now() / 1000;
    const sx = shake * 0.012 * Math.sin(t * 71.3);
    const sy = shake * 0.012 * Math.sin(t * 57.1 + 1.7);
    // Strafe tilt: the view leans a degree or two into the way we strafe (off with head bob).
    const f = tuning.feel;
    const lateral =
      m.velocity[0] * Math.cos(input.look.yaw) - m.velocity[2] * Math.sin(input.look.yaw);
    const tiltTarget = settings().headBob
      ? (-lateral / movement.sprintSpeed) * f.strafeTilt * (Math.PI / 180)
      : 0;
    tilt += (tiltTarget - tilt) * (1 - Math.exp(-frame * 8));
    // Scoped rifle drift (the simulation's, so the shot goes where the view shows), eased
    // between the last two ticks like the position.
    const swaySpec = simCtx.loadout[w.slot];
    const [swayNowYaw, swayNowPitch] = scopeSway(w, swaySpec);
    const [swayPrevYaw, swayPrevPitch] =
      prevState.weapon.slot === w.slot ? scopeSway(prevState.weapon, swaySpec) : [0, 0];
    const swayYaw = lerp(swayPrevYaw, swayNowYaw, a) * RAD_PER_UNIT;
    const swayPitch = lerp(swayPrevPitch, swayNowPitch, a) * RAD_PER_UNIT;
    camera.rotation.set(
      input.look.pitch + w.recoilPitch * RAD_PER_UNIT + sx + swayPitch,
      input.look.yaw + w.recoilYaw * RAD_PER_UNIT + sy + swayYaw,
      shake * 0.006 * Math.sin(t * 43.9) + tilt,
    );
    // How far the view turned since the last frame (weapon sway).
    let turnYaw = input.look.yaw - lastLookYaw;
    turnYaw -= Math.round(turnYaw / (2 * Math.PI)) * 2 * Math.PI;
    const turnPitch = input.look.pitch - lastLookPitch;
    lastLookYaw = input.look.yaw;
    lastLookPitch = input.look.pitch;
    const replaying = updateKillcam(frame);
    const teammates: { x: number; z: number; yaw: number }[] = [];
    for (const [id, pose] of remotePoses) {
      if (id !== myId && pose.alive && pose.team === myTeam()) {
        teammates.push({ x: pose.position[0], z: pose.position[2], yaw: pose.yaw });
      }
    }
    minimap.draw(
      { x: px, z: pz, yaw: input.look.yaw },
      teammates,
      objectives,
      myTeam(),
      hud.alive && !replaying,
    );
    // Hurt: a pulse at the screen edge on each hit; below 35 health a slow heartbeat pulse and
    // (Medium/High) the colour drains. Blood-free (PEGI 12): a vignette, not gore.
    const sinceHurt = (performance.now() - hurtAt) / 600;
    const pulse = sinceHurt >= 0 && sinceHurt < 1 ? 1 - sinceHurt : 0;
    const low = hud.alive && hud.health < 35 ? (35 - hud.health) / 35 : 0;
    const beat = low > 0 ? low * (0.55 + 0.45 * Math.sin(performance.now() / 180) ** 2) : 0;
    const stress = hud.alive ? Math.min(1, Math.max(pulse * 0.8, beat)) : 0;
    hurtEl.style.opacity = stress.toFixed(3);
    post?.setStress(Math.max(low, pulse * 0.4));
    const armorSeconds = hud.alive
      ? Math.max(0, Math.ceil((armorUntil - performance.now()) / 1000))
      : 0;
    if (armorSeconds !== hud.armorSeconds) {
      hud.armorSeconds = armorSeconds;
      hudDirty = true;
    }
    syncLoadout();
    applyGraphics();
    effects.setMuzzleLight(GRAPHICS[settings().graphics].post);
    viewerTeam.value = myTeam(); // soldiers' rim light: red for enemies, blue for allies
    const spec = simCtx.loadout[w.slot];
    const ads = adsFraction(w, spec);
    // Aiming zooms by the weapon's current zoom level (the wheel steps through its levels
    // while aiming); a marksman scope draws the scope view over the screen once the rifle is
    // nearly up (the rifle model is hidden behind it).
    const levels = spec.def.zoomLevels;
    const slotZoom = zoomIndex[w.slot];
    zoomIndex[w.slot] = Math.max(0, Math.min(levels.length - 1, slotZoom + input.zoomSteps));
    input.zoomSteps = 0;
    const level = levels[zoomIndex[w.slot]]!;
    const magnification = 1 + (level - 1) * ads;
    const marksman = spec.def.class === 'marksman';
    const scoped = marksman && ads > 0.85 && hud.alive;
    scopeEl.classList.toggle('on', scoped);
    document.body.classList.toggle('scoped', scoped);
    if (scoped && spec.scope) {
      // Breath left (holding) or catching it again (recovering: the bar refills, red).
      const breath =
        w.recoverTicks > 0
          ? 1 - w.recoverTicks / spec.scope.recoverTicks
          : 1 - w.breathTicks / spec.scope.holdTicks;
      breathEl.style.setProperty('--breath', breath.toFixed(3));
      breathEl.classList.toggle('recovering', w.recoverTicks > 0);
      breathEl.classList.toggle('holding', w.breathTicks > 0);
      const hint = `Hold ${keyLabel(settings().bindings.sprint)} to steady`;
      if (breathEl.lastElementChild!.textContent !== hint)
        breathEl.lastElementChild!.textContent = hint;
    }
    const showZoom = hud.alive && ads > 0.5 && levels.length > 1;
    zoomEl.classList.toggle('on', showZoom);
    if (showZoom) zoomEl.textContent = `${level}×`;
    // Magnification m narrows the view so things look m times bigger: tan(fov/2) / m.
    const baseFov = settings().fov;
    const zoomedFov = zoomedFovDegrees(baseFov, magnification);
    // Mouse look slows by the same factor, so a small hand movement still covers the same
    // part of the (bigger) target: precise headshots when zoomed in.
    input.lookScale = 1 / magnification;
    // Headshot kill: a quick zoom punch (0.45 s), never enough to lose the target.
    const hsT = (performance.now() - headshotAt) / 450;
    const killT = (performance.now() - killAt) / 300;
    const punch =
      hsT >= 0 && hsT < 1
        ? Math.sin(Math.PI * hsT) * 0.1
        : killT >= 0 && killT < 1
          ? Math.sin(Math.PI * killT) * 0.035
          : 0;
    // Sprinting widens the view a little (tactical sprint more); never while aiming.
    const sprinting =
      m.grounded && !m.crouching && m.slideTicks === 0 && speed > movement.walkSpeed + 0.5;
    const fovBoost =
      (m.tacSprintTicks > 0 ? f.tacSprintFovBoost : sprinting ? f.sprintFovBoost : 0) * (1 - ads);
    sprintFov += (fovBoost - sprintFov) * (1 - Math.exp(-frame * 6));
    const vfov = verticalFovDegrees((zoomedFov + sprintFov) * (1 - punch), camera.aspect);
    if (Math.abs(camera.fov - vfov) > 0.01) {
      camera.fov = vfov;
      camera.updateProjectionMatrix();
    }
    viewmodel.root.visible = hud.alive && !scoped;
    viewmodel.setTeam(myTeam());
    viewmodel.update(frame, {
      slot: w.slot,
      ads,
      reloading: w.reloadTicks > 0 ? Math.sin((1 - w.reloadTicks / spec.reloadTicks) * Math.PI) : 0,
      switching: w.switchTicks / spec.equipTicks,
      speed,
      grounded: m.grounded,
      turnYaw,
      turnPitch,
      kick: kickFor(f, spec.def),
      sway: f.sway,
      gunBob: f.gunBob,
    });
    tuning.weapon = spec.def;
    effects.tracerSpeed = f.tracerSpeed;
    effects.tracerLength = f.tracerLength;
    if (tuning.version !== tuningVersion) {
      // The F1 panel changed the look: apply its override (or go back to the map's own).
      tuningVersion = tuning.version;
      post?.setGrade(tuning.grade ?? LOOKS[map.lighting]);
      renderer.toneMappingExposure = tuning.exposure ?? EXPOSURE;
    }
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
        audio.footstep(
          m.crouching ? 0.08 : sprinting ? 0.4 : 0.28,
          undefined,
          groundSurface(m.position[0], m.position[1], m.position[2]),
        );
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
      remotePlayers.beginFrame();
      glints.begin();
      for (const [id, buf] of remoteBuffers) {
        const pose = buf.sample(renderTick);
        if (!pose) continue;
        remotePoses.set(id, pose);
        remotePlayers.update(id, pose, frame);
        remoteFootsteps(id, pose, frame);
        // Scope glint: an enemy aimed in through a scope (their lens, just ahead of the head).
        if (
          pose.scoped &&
          pose.alive &&
          pose.team !== myTeam() &&
          remotePlayers.headOf(id, lensAt)
        ) {
          const cp = Math.cos(pose.pitch);
          lensAt.x += -Math.sin(pose.yaw) * cp * 0.3;
          lensAt.y += Math.sin(pose.pitch) * 0.3 - 0.4; // headOf is the name-tag point, above the head
          lensAt.z += -Math.cos(pose.yaw) * cp * 0.3;
          glints.add(pose, lensAt, camera.position, performance.now() / 1000);
        }
      }
      glints.end();
      grenadeView.update(renderTick, performance.now());
    }
    if (!replaying) updateAimAndTags();
    feedback.update(camera, frame);
    effects.update(frame);
    dust.update(frame, camera.position, GRAPHICS[settings().graphics].post);
    renderer.info.reset();
    if (worldReady) draw();
    devStats.push(frame * 1000);
    devStats.drawCalls = renderer.info.render.drawCalls;
    devStats.triangles = renderer.info.render.triangles;
    devStats.geometries = renderer.info.memory.geometries;
    devStats.textures = renderer.info.memory.textures;
    devStats.renderScale = settings().renderScale * dynamicScale;

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
          prone: m.prone,
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
      setLeaveGuard(false); // leaving on purpose: no "Leave site?" question
      // A fresh page is the cleanest way out: no half-torn-down match state survives.
      const url = new URL(location.href);
      url.searchParams.delete('room');
      url.searchParams.delete('with');
      location.assign(url.toString());
    },
    switchTeam: () => conn.switchTeam(),
    requestPlay: () => {
      audio.unlock();
      // Fullscreen with the keyboard locked (setting, default on): Ctrl+W can't close the game.
      if (settings().fullscreen) void enterGameFullscreen();
      return input.requestLock();
    },
  };
}

function eyeHeightFor(crouching: boolean, prone = false): number {
  return eyeHeightOf(movement, crouching, prone);
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

/** Tone-mapping exposure (the physical sky is scaled for ~0.5; lights doubled). */
const EXPOSURE = 0.58;

/** How strong the sky's own light is, and how much of the flat fill light remains with it. */
const SKY_LIGHT = 0.12;
const HEMI_UNDER_SKY_LIGHT = 0.6;

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
    /** Sky: haze (2 clear – 10 hazy), blue scattering, cloud cover 0–1. */
    turbidity: number;
    rayleigh: number;
    clouds: number;
  }
> = {
  // A higher sun, but low enough for readable shadows; the fill (hemisphere) is kept well
  // below the sun: a flat, evenly lit scene is what made the maps look lifeless.
  day: {
    sky: 0x9cc8ee,
    fogNear: 55,
    fogFar: 170,
    hemiSky: 0xd6e2f4,
    hemiGround: 0x6a5c4e,
    hemiIntensity: 2.1,
    sun: 0xfff0d6,
    sunIntensity: 6.2,
    sunPosition: [26, 30, 18],
    turbidity: 3,
    rayleigh: 1.4,
    clouds: 0.4,
  },
  // Late afternoon: warm low sun, long shadows, blue shade.
  golden: {
    sky: 0xf2c89a,
    fogNear: 45,
    fogFar: 160,
    hemiSky: 0xc4cddd,
    hemiGround: 0x74604e,
    hemiIntensity: 2.3,
    sun: 0xffc27a,
    sunIntensity: 6.6,
    sunPosition: [34, 13, 22],
    turbidity: 5,
    rayleigh: 2.2,
    clouds: 0.3,
  },
  dusk: {
    sky: 0xe39a6b,
    fogNear: 45,
    fogFar: 150,
    hemiSky: 0xf0c8b0,
    hemiGround: 0x5a4a52,
    hemiIntensity: 2.3,
    sun: 0xffa36a,
    sunIntensity: 5.2,
    sunPosition: [35, 11, -20],
    turbidity: 4,
    rayleigh: 3,
    clouds: 0.5,
  },
};

/**
 * Ground haze per mood (Medium/High, see post.ts): colours in linear light at scene level
 * (before exposure), so they sit with the lit map rather than on top of it.
 */
const HAZE: Record<GameMap['lighting'], Haze> = {
  day: {
    color: [0.95, 1.08, 1.25],
    sunColor: [1.8, 1.6, 1.25],
    density: 0.006,
    falloff: 6,
    max: 0.3,
    shafts: 0.3,
  },
  golden: {
    color: [1.2, 1.02, 0.88],
    sunColor: [2.2, 1.45, 0.8],
    density: 0.008,
    falloff: 7,
    max: 0.36,
    shafts: 0.45,
  },
  dusk: {
    color: [1.0, 0.8, 0.8],
    sunColor: [2.0, 1.15, 0.7],
    density: 0.009,
    falloff: 8,
    max: 0.38,
    shafts: 0.4,
  },
};

/** The graded look per mood (Medium/High, see post.ts). */
const LOOKS: Record<GameMap['lighting'], Grade> = {
  day: {
    contrast: 1.07,
    saturation: 1.07,
    shadowTint: [-0.006, 0, 0.01],
    highlightTint: [0.02, 0.01, -0.012],
    vignette: 0.3,
    grain: 0.022,
  },
  golden: {
    contrast: 1.08,
    saturation: 1.1,
    shadowTint: [-0.006, 0, 0.012],
    highlightTint: [0.035, 0.014, -0.02],
    vignette: 0.34,
    grain: 0.026,
  },
  dusk: {
    contrast: 1.08,
    saturation: 1.05,
    shadowTint: [-0.006, -0.002, 0.016],
    highlightTint: [0.04, 0.008, -0.01],
    vignette: 0.36,
    grain: 0.028,
  },
};

/**
 * Per preset: shadow map size (0 = no shadows), whether shadows are redrawn every frame (with
 * soldiers), MSAA, and the highest device pixel ratio used.
 */
const GRAPHICS: Record<
  GraphicsPreset,
  {
    shadowMapSize: number;
    dynamicShadows: boolean;
    antialias: boolean;
    maxPixelRatio: number;
    bloom: boolean;
    /** Light from the sky (environment map): costs a little on every lit pixel. */
    skyLight: boolean;
    /** Colour grading, vignette and grain (one extra full-screen pass). */
    post: boolean;
    /** Ambient occlusion: contact shadows in corners (half resolution). */
    ambientOcclusion: boolean;
    /** Sun shafts between buildings (24 depth samples per pixel). */
    sunShafts: boolean;
  }
> = {
  low: {
    shadowMapSize: 0,
    dynamicShadows: false,
    antialias: false,
    maxPixelRatio: 1,
    bloom: false,
    skyLight: false,
    post: false,
    ambientOcclusion: false,
    sunShafts: false,
  },
  medium: {
    shadowMapSize: 1024,
    dynamicShadows: false,
    antialias: true,
    maxPixelRatio: 1.5,
    bloom: false,
    skyLight: true,
    post: true,
    ambientOcclusion: false,
    sunShafts: false,
  },
  high: {
    shadowMapSize: 2048,
    dynamicShadows: true,
    antialias: true,
    maxPixelRatio: 2,
    bloom: true,
    skyLight: true,
    post: true,
    ambientOcclusion: true,
    sunShafts: true,
  },
};
