import {
  KILL_SOURCE_FRAG,
  buildLoadout,
  defaultBuiltLoadout,
  equipment,
  loadoutToWire,
  weaponCatalog,
  weapons,
  weaponIndex,
  type GameMap,
  type Loadout,
  type LoadoutWire,
  type Movement,
  type Weapon,
} from '@sentinel/content';
import { NO_WEAPON, type EntityState, type GameEvent, type Snapshot } from '@sentinel/protocol';
import {
  MAX_PLAYERS_PER_MATCH,
  MAX_REWIND_MS,
  TICK_RATE,
  Button,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  capsuleHeight,
  createPlayerState,
  createRng,
  compileWeapon,
  createWeaponState,
  damageAt,
  directionFromAngles,
  expandMap,
  eyePosition,
  rayPlayer,
  removePlayerBody,
  stepSim,
  yawFromDegrees,
  type HitZone,
  type PlayerBody,
  type Rapier,
  type ShotRequest,
  type SimContext,
  type WeaponSpec,
  type SimState,
  type Vec3,
} from '@sentinel/shared';
import { SNAP_DEGREES, newAimStats, type AimStats } from './anticheat.ts';
import { Grenades, type Detonation } from './grenades.ts';
import { InputQueue, type TickInput } from './inputQueue.ts';

export const MAX_HEALTH = 100;
/** Respawn 3 s after death (Phase 2 task 6). */
export const RESPAWN_TICKS = 3 * TICK_RATE;
/** Health starts coming back 4 s after the last damage and refills in ~1.7 s (GAME_DESIGN). */
export const REGEN_DELAY_TICKS = 4 * TICK_RATE;
export const REGEN_PER_TICK = 1;
/** Lag compensation never rewinds further than this (NETCODE.md, ADR 0005). */
export const MAX_REWIND_TICKS = Math.round((MAX_REWIND_MS / 1000) * TICK_RATE);
/**
 * Anti-"backtrack" (review H1). A client says which tick it was looking at (viewTick, ADR 0005);
 * a cheater could jump it back for a single shot to hit players who already reached cover.
 * Rule: the view tick may move forward freely (that only means less rewind), but may move back
 * by at most VIEW_TICK_MAX_RETREAT per input. Honest clients only drift back slowly (their
 * interpolation delay grows a little under jitter); a per-shot jump back is refused.
 *
 * Note: a client below 60 fps sends several inputs per rendered frame with the same view tick,
 * so the gap (server tick − view tick) legitimately saw-tooths by the ticks-per-frame. Rules
 * built on that gap (an earlier version) cut those players' rewinds short; this one doesn't.
 */
export const VIEW_TICK_MAX_RETREAT = 0.25;

export interface ViewTickGovernor {
  last: number | null;
}

export function governViewTick(g: ViewTickGovernor, claimed: number): number {
  const v =
    g.last === null || !Number.isFinite(g.last)
      ? claimed
      : Math.max(claimed, g.last - VIEW_TICK_MAX_RETREAT);
  g.last = v;
  return v;
}

/** Anti-wallhack (PVS): enemies this close are always sent (you'd hear their steps). */
export const PVS_HEAR_METRES = 8;
/** Gunfire is heard this far for this long. */
export const PVS_SHOT_HEARD_METRES = 60;
export const PVS_SHOT_HEARD_TICKS = Math.round(0.5 * TICK_RATE);
/** Look-ahead for peeks, and how long a visible enemy stays sent. */
export const PVS_LEAD_S = 0.25;
export const PVS_HOLD_TICKS = Math.round(0.5 * TICK_RATE);
/**
 * A hidden enemy is checked again after this many ticks (0.1 s). Safe because the look-ahead
 * (PVS_LEAD_S, 0.25 s) covers more movement than this delay.
 */
export const PVS_RECHECK_TICKS = 6;

/** Spawn protection: 1.5 s, or until you fire (Phase 3). */
export const SPAWN_PROTECTION_TICKS = Math.round(1.5 * TICK_RATE);
/** One second of hitbox history per player. */
const HISTORY_TICKS = TICK_RATE;

interface HistoryEntry {
  tick: number;
  position: Vec3;
  crouching: boolean;
  alive: boolean;
}

export interface SimPlayer {
  id: number;
  team: number;
  name: string;
  /** Guest profile id for progression (humans; validated by the room). */
  guestId: string | null;
  /** Public player code shown to others (friends); '' for bots and anonymous players. */
  code: string;
  /** Server bot: its input comes from `botInput` (set by the bot controller each tick). */
  bot: boolean;
  botInput: TickInput | null;
  /** This player's loadout: compiled weapons (ctx) and the validated choice (for the wire). */
  ctx: SimContext;
  loadout: Loadout;
  /** Cached per spawn for snapshots: the loadout on the wire and each slot's weapon index. */
  loadoutWire: LoadoutWire;
  weaponIdx: [number, number];
  /** Chosen in the menu mid-match: applied at the next spawn, never mid-life. */
  pendingLoadout: Loadout | null;
  /** Tick this player joined (time played in a match counts from here). */
  joinedAtTick: number;
  /** Damage is ignored before this tick (spawn protection). */
  protectedUntil: number;
  body: PlayerBody;
  sim: SimState;
  queue: InputQueue;
  health: number;
  alive: boolean;
  lifeId: number;
  respawnTicks: number;
  lastDamageTick: number;
  shotCount: number;
  /** Grenades left this life (refilled on respawn). */
  frags: number;
  smokes: number;
  /**
   * The grenade keys were seen released since this life (or live play) began. A key held
   * through a respawn or the countdown must not throw on the first live tick.
   */
  throwArmed: boolean;
  /** No new throw before this tick (throw cooldown). */
  nextThrowTick: number;
  kills: number;
  deaths: number;
  /** This match: kills by headshot, by frag, and per weapon id (progression, challenges). */
  headshots: number;
  fragKills: number;
  weaponKills: Map<string, number>;
  /** Anti-cheat measurements for this match (anticheat.ts). */
  aim: AimStats;
  /** Account level (from the API's unlocks; 1 if unknown), for the K/D-vs-level flag. */
  level: number;
  history: HistoryEntry[];
  /** Last tick this player fired (gunfire is audible, so it counts as visible nearby). */
  lastShotTick: number;
  /** Anti-wallhack hysteresis: enemy id → keep sending them to this player until this tick. */
  sendUntil: Map<number, number>;
  /** …and don't re-check a hidden enemy before this tick. */
  hiddenUntil: Map<number, number>;
  /** View tick after anti-backtrack governing (see governViewTick). */
  viewTick: number;
  viewGovernor: ViewTickGovernor;
}

/** A resolved shot, for tests and effects. */
export interface ShotResult {
  shooter: number;
  origin: Vec3;
  dir: Vec3;
  hit: { victim: number; zone: HitZone; damage: number; distance: number } | null;
  /** Distance to the wall the shot stopped at, if it hit the map first (or no player). */
  wallDistance: number | null;
}

/**
 * The authoritative match simulation, free of any networking so it can be tested directly.
 * MatchRoom feeds it inputs and turns its snapshots and events into bytes.
 */
export class MatchSim {
  tick = 0;
  lastTickMicros = 0;
  readonly players = new Map<number, SimPlayer>();
  /** Events produced by the last step, with who should receive them (null = everyone). */
  events: { to: number | null; event: GameEvent }[] = [];
  /** Shots resolved by the last step (tests, debugging). */
  lastShots: ShotResult[] = [];
  /**
   * Test-only (SENTINEL_TEST_NO_DEATH): health never drops below 1, so hit-registration tests
   * aren't skewed by shots at targets that just died. Never set in real matches.
   */
  noDeath = false;
  /** Objective mode points (Domination sets them each tick; bots head for them). */
  objectives: readonly { position: Vec3; owner: number }[] = [];
  /** Anti-wallhack visibility filter for snapshots (tests may switch it off). */
  pvs = true;
  /** Default loadout context; each player has their own (SimPlayer.ctx). */
  private ctx: SimContext;
  private readonly specs = new Map<string, WeaponSpec>();
  /** Thrown frags and smokes (server-only simulation). */
  grenades: Grenades;
  private readonly random: () => number;
  private spawnCursor = [0, 0];

  constructor(
    private readonly rapier: Rapier,
    private map: GameMap,
    private readonly tuning: Movement,
    loadout: readonly [Weapon, Weapon],
    seed = 1,
  ) {
    const movementCtx = createMovementContext(rapier, buildWorld(rapier, expandMap(map)), tuning);
    this.ctx = { movement: movementCtx, loadout: [this.spec(loadout[0]), this.spec(loadout[1])] };
    this.random = createRng(seed);
    this.grenades = new Grenades(rapier, movementCtx.world, tuning.gravity);
  }

  /** The map being played. */
  get currentMap(): GameMap {
    return this.map;
  }

  /**
   * Switch to another map between matches (map rotation): a new physics world, every player
   * gets a body in it and is respawned there. Loadouts, names, teams and ids stay.
   */
  /** Tick of the last map change: rewinds never reach back before it (review L6). */
  private mapChangedTick = 0;

  changeMap(map: GameMap): void {
    this.mapChangedTick = this.tick;
    const old = this.ctx.movement.world;
    const movementCtx = createMovementContext(
      this.rapier,
      buildWorld(this.rapier, expandMap(map)),
      this.tuning,
    );
    this.map = map;
    this.ctx = { movement: movementCtx, loadout: this.ctx.loadout };
    this.grenades = new Grenades(this.rapier, movementCtx.world, this.tuning.gravity);
    this.spawnCursor = [0, 0];
    for (const p of this.players.values()) {
      p.body = createPlayerBody(movementCtx);
      p.ctx = { movement: movementCtx, loadout: p.ctx.loadout };
      p.history = [];
    }
    old.free();
    this.respawnAll();
  }

  /** Compiled weapons are shared between players (compiled once per weapon). */
  private spec(w: Weapon): WeaponSpec {
    // Weapons changed by attachments/perks are compiled per loadout (cheap, only at spawn).
    if (weapons[w.id] !== w) return compileWeapon(w);
    let s = this.specs.get(w.id);
    if (!s) this.specs.set(w.id, (s = compileWeapon(w)));
    return s;
  }

  private contextFor(loadout: Loadout): SimContext {
    const [a, b] = loadout.weapons;
    return { movement: this.ctx.movement, loadout: [this.spec(a), this.spec(b)] };
  }

  /**
   * Choose a loadout (already validated with buildLoadout). It takes effect at the player's
   * next spawn, so a weapon can't be swapped mid-fight and the client's prediction only ever
   * changes loadout together with a respawn reset.
   */
  setLoadout(id: number, loadout: Loadout): void {
    const p = this.players.get(id);
    if (p) p.pendingLoadout = loadout;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS_PER_MATCH;
  }

  /** Players per team right now. */
  teamCounts(): [number, number] {
    const counts: [number, number] = [0, 0];
    for (const p of this.players.values()) counts[p.team as 0 | 1]++;
    return counts;
  }

  addPlayer(
    opts: {
      name?: string;
      bot?: boolean;
      team?: number;
      guestId?: string | null;
      code?: string;
      level?: number;
      /** A built loadout, or just [primary, secondary] (no attachments or perks). */
      loadout?: Loadout | readonly [Weapon, Weapon];
    } = {},
  ): SimPlayer {
    if (this.isFull) throw new Error('match is full');
    let id = 1;
    while (this.players.has(id)) id++;
    const [a, b] = this.teamCounts();
    const team = opts.team ?? (a <= b ? 0 : 1);
    const loadout = asLoadout(opts.loadout);
    const ctx = this.contextFor(loadout);
    const player: SimPlayer = {
      id,
      team,
      name: opts.name ?? `Player ${id}`,
      guestId: opts.guestId ?? null,
      code: opts.code ?? '',
      bot: opts.bot ?? false,
      botInput: null,
      ctx,
      loadout,
      loadoutWire: loadoutToWire(loadout),
      weaponIdx: [weaponIndex(loadout.choice.primary), weaponIndex(loadout.choice.secondary)],
      pendingLoadout: null,
      protectedUntil: this.tick + SPAWN_PROTECTION_TICKS,
      joinedAtTick: this.tick,
      body: createPlayerBody(this.ctx.movement),
      sim: this.freshSim(team, ctx),
      queue: new InputQueue(),
      health: MAX_HEALTH,
      alive: true,
      lifeId: 1,
      respawnTicks: 0,
      lastDamageTick: -Infinity,
      shotCount: 0,
      lastShotTick: -Infinity,
      sendUntil: new Map(),
      hiddenUntil: new Map(),
      frags: equipment.frag.perLife,
      smokes: equipment.smoke.perLife,
      throwArmed: false,
      nextThrowTick: 0,
      kills: 0,
      deaths: 0,
      headshots: 0,
      fragKills: 0,
      weaponKills: new Map(),
      aim: newAimStats(),
      level: opts.level ?? 1,
      history: [],
      viewTick: 0,
      viewGovernor: { last: null },
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    removePlayerBody(this.ctx.movement, p.body);
    this.grenades.removeOwner(id);
    this.players.delete(id);
  }

  /**
   * While frozen (countdown, results screen) inputs are still consumed, so seqs keep flowing,
   * but nobody moves or shoots.
   */
  frozen = false;

  /** One fixed 1/60 s tick: move everyone, then resolve this tick's shots, then health. */
  step(): void {
    const start = performance.now();
    this.events = [];
    this.lastShots = [];
    const shots: { shooter: SimPlayer; shot: ShotRequest; viewTick: number }[] = [];

    for (const p of this.players.values()) {
      // Always consumed, even while dead or frozen, so seqs keep flowing.
      const input = p.bot ? p.botInput : p.queue.next();
      if (!input) continue;
      p.viewTick = governViewTick(p.viewGovernor, input.viewTick);
      if (!p.alive || this.frozen) continue;
      const before = p.sim;
      // Snap detection: how far the view turned this tick (16-bit yaw, wrapped).
      const dyaw = Math.abs((((input.yaw - before.move.yaw) & 0xffff) << 16) >> 16);
      if (dyaw * (360 / 65536) > SNAP_DEGREES) p.aim.lastSnapTick = this.tick;
      const r = stepSim(p.sim, input, p.ctx, p.body);
      p.sim = r.state;
      this.maybeThrow(p, before);
      if (r.shot) {
        p.protectedUntil = 0; // firing ends spawn protection
        p.shotCount = (p.shotCount + 1) & 0xff;
        p.lastShotTick = this.tick;
        p.aim.shots++;
        shots.push({ shooter: p, shot: r.shot, viewTick: p.viewTick });
      }
      if (p.sim.move.position[1] < this.map.killY) this.kill(p, null, NO_WEAPON, false);
    }

    this.tick++;
    this.recordHistory();
    // Every shot fired this tick counts, even if its shooter was killed by an earlier shot in
    // this same loop: both players pulled the trigger while alive (fair trades, not join order).
    for (const s of shots) this.resolveShot(s.shooter, s.shot, s.viewTick);
    if (!this.frozen) for (const d of this.grenades.step()) this.detonate(d);
    this.updateLife();
    this.lastTickMicros = (performance.now() - start) * 1000;
  }

  snapshotFor(id: number): Snapshot {
    const me = this.players.get(id);
    const entities: EntityState[] = [];
    const myEye = me ? eyePosition(me.sim.move, this.ctx.movement) : null;
    for (const p of this.players.values()) {
      if (p.id === id) continue;
      const m = p.sim.move;
      // Anti-wallhack (Phase 7): an enemy is only sent if this player could see or hear them.
      // An enemy fully hidden by smoke is never sent (a client that just stops drawing the
      // cloud must not learn where they are). Clients drop players missing from a snapshot.
      if (myEye && me && p.team !== me.team) {
        if (this.hiddenBySmoke(myEye, p) || !this.shouldSend(me, myEye, p)) continue;
      }
      entities.push({
        id: p.id,
        team: p.team,
        alive: p.alive,
        grounded: m.grounded,
        crouching: m.crouching,
        position: m.position,
        yaw: m.yaw,
        pitch: m.pitch,
        weapon: p.weaponIdx[p.sim.weapon.slot]!,
        shotCount: p.shotCount,
      });
    }
    return {
      serverTick: this.tick,
      lastProcessedSeq: me?.queue.lastProcessedSeq ?? 0,
      inputQueueDepth: me?.queue.depth ?? 0,
      serverTickMicros: this.lastTickMicros,
      own: me
        ? {
            sim: {
              move: {
                position: me.sim.move.position,
                velocity: me.sim.move.velocity,
                grounded: me.sim.move.grounded,
                crouching: me.sim.move.crouching,
                slideTicks: me.sim.move.slideTicks,
                slideCooldownTicks: me.sim.move.slideCooldownTicks,
                prevButtons: me.sim.move.prevButtons,
              },
              weapon: me.sim.weapon,
            },
            loadout: me.loadoutWire,
            health: me.health,
            lifeId: me.lifeId,
            respawnTicks: me.respawnTicks,
            frags: me.frags,
            smokes: me.smokes,
          }
        : null,
      entities,
      projectiles: this.grenades.list.map((g) => ({
        id: g.id,
        kind: g.def.kind,
        cloud: g.cloudTicks > 0,
        position: g.position,
      })),
    };
  }

  // --- Shots -------------------------------------------------------------------------------

  /**
   * Hitscan with lag compensation (docs/NETCODE.md, ADR 0005): move every other player's
   * hitboxes back to what the shooter saw (their governed view tick, at most 300 ms ago, ADR 0005/0006), cast from the
   * shooter's current server-side eye along the shot's angles plus random spread, and let the
   * map block the shot.
   */
  private resolveShot(shooter: SimPlayer, shot: ShotRequest, viewTick: number): void {
    const spec = shooter.ctx.loadout[shot.slot];
    const weapon = spec.def;
    const origin = eyePosition(shooter.sim.move, this.ctx.movement);
    // Never rewind across a map change: poses from the old map mean nothing on this one.
    const rewindTick = Math.max(
      this.tick - MAX_REWIND_TICKS,
      this.mapChangedTick,
      Math.min(this.tick, viewTick),
    );
    // Rewound poses are computed once per shot, not once per pellet.
    const targets: { victim: SimPlayer; position: Vec3; crouching: boolean }[] = [];
    for (const target of this.players.values()) {
      if (target === shooter || target.team === shooter.team || !target.alive) continue;
      const pose = this.poseAt(target, rewindTick);
      if (pose?.alive) targets.push({ victim: target, ...pose });
    }

    // A shotgun fires several pellets; their damage adds up per victim, so one blast is one
    // hit (one event, one kill) no matter how many pellets land.
    const cone = shot.spread + spec.pelletSpread;
    const byVictim = new Map<SimPlayer, Record<HitZone, number>>();
    for (let i = 0; i < spec.pellets; i++) {
      // Random spread inside the cone (server-only randomness; the client shows its own guess).
      const r = cone * Math.sqrt(this.random());
      const theta = this.random() * Math.PI * 2;
      const dir = directionFromAngles(
        (shot.yaw + Math.round(r * Math.cos(theta))) & 0xffff,
        Math.max(-16383, Math.min(16383, shot.pitch + Math.round(r * Math.sin(theta)))),
      );
      const wallHit = this.ctx.movement.world.castRay(
        new this.rapier.Ray(
          { x: origin[0], y: origin[1], z: origin[2] },
          { x: dir[0], y: dir[1], z: dir[2] },
        ),
        weapon.maxRange,
        true,
        this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
      );
      const wallDistance = wallHit ? wallHit.timeOfImpact : null;
      const maxDist = wallDistance ?? weapon.maxRange;

      let best: { victim: SimPlayer; zone: HitZone; distance: number } | null = null;
      for (const t of targets) {
        const hit = rayPlayer(origin, dir, t.position, t.crouching, this.tuning, maxDist);
        if (hit && (!best || hit.distance < best.distance)) best = { victim: t.victim, ...hit };
      }

      const result: ShotResult = { shooter: shooter.id, origin, dir, hit: null, wallDistance };
      if (best) {
        const damage = damageAt(weapon.damage[best.zone], best.distance, weapon.falloff);
        result.hit = { victim: best.victim.id, zone: best.zone, damage, distance: best.distance };
        let sum = byVictim.get(best.victim);
        if (!sum) byVictim.set(best.victim, (sum = { head: 0, torso: 0, limbs: 0 }));
        sum[best.zone] += damage;
      }
      this.lastShots.push(result);
    }
    if (byVictim.size > 0) {
      shooter.aim.hits++;
      if (this.tick - shooter.aim.lastSnapTick <= 2) shooter.aim.snapHits++;
    }
    for (const victim of byVictim.keys()) {
      // Reaction time: from this enemy entering the shooter's line of sight to this first hit.
      const since = shooter.aim.visibleSince.get(victim.id);
      if (since !== undefined) {
        shooter.aim.reactionsMs.push(((this.tick - since) * 1000) / TICK_RATE);
        shooter.aim.visibleSince.delete(victim.id);
      }
    }
    for (const [victim, z] of byVictim) {
      // The zone that took most of the damage is the one reported (a blast with one stray
      // pellet in the head is not a headshot).
      const zone: HitZone =
        z.head >= z.torso && z.head >= z.limbs ? 'head' : z.torso >= z.limbs ? 'torso' : 'limbs';
      this.damage(victim, shooter, z.head + z.torso + z.limbs, zone, weaponIndex(weapon.id));
    }
  }

  private damage(
    victim: SimPlayer,
    attacker: SimPlayer,
    damage: number,
    zone: HitZone,
    weapon: number,
    from: Vec3 = attacker.sim.move.position,
  ): void {
    if (!victim.alive || this.tick < victim.protectedUntil) return;
    const self = victim === attacker;
    victim.health = Math.max(this.noDeath ? 1 : 0, victim.health - damage);
    victim.lastDamageTick = this.tick;
    const killed = victim.health === 0;
    if (!self) {
      this.events.push({
        to: attacker.id,
        event: { type: 'hit', victim: victim.id, damage, zone, killed },
      });
    }
    this.events.push({
      to: victim.id,
      event: {
        type: 'damaged',
        attacker: attacker.id,
        from,
        health: victim.health,
      },
    });
    // Killing yourself (your own frag) is a death, not a kill: no score, no scavenged ammo.
    if (killed) this.kill(victim, self ? null : attacker, weapon, zone === 'head');
  }

  private kill(
    victim: SimPlayer,
    killer: SimPlayer | null,
    weapon: number,
    headshot: boolean,
  ): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.respawnTicks = RESPAWN_TICKS;
    victim.deaths++;
    if (killer) {
      killer.kills++;
      if (headshot) killer.headshots++;
      if (weapon === KILL_SOURCE_FRAG) killer.fragKills++;
      const id = weaponCatalog[weapon]?.id;
      if (id) killer.weaponKills.set(id, (killer.weaponKills.get(id) ?? 0) + 1);
      this.rewardAmmo(killer);
    }
    // A fall (no killer) shows as the victim "killing" themselves in the feed.
    this.events.push({
      to: null,
      event: {
        type: 'kill',
        killer: killer?.id ?? victim.id,
        victim: victim.id,
        weapon,
        headshot,
      },
    });
  }

  /**
   * Scavenging: each kill adds one magazine to both weapons' reserve (capped at the starting
   * reserve), so aggressive players don't run dry mid-fight. Server-side like all ammo; the
   * client picks it up from its next snapshot.
   */
  private rewardAmmo(p: SimPlayer): void {
    const w = p.sim.weapon;
    const ammo = w.ammo.map((a, i) => {
      const def = p.ctx.loadout[i as 0 | 1].def;
      return { ammo: a.ammo, reserve: Math.min(def.reserve, a.reserve + def.magazine) };
    }) as SimState['weapon']['ammo'];
    p.sim = { ...p.sim, weapon: { ...w, ammo } };
  }

  private updateLife(): void {
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (--p.respawnTicks <= 0) this.respawn(p);
      } else if (p.health < MAX_HEALTH && this.tick - p.lastDamageTick >= REGEN_DELAY_TICKS) {
        p.health = Math.min(MAX_HEALTH, p.health + REGEN_PER_TICK);
      }
    }
  }

  private respawn(p: SimPlayer): void {
    if (p.pendingLoadout) {
      p.ctx = this.contextFor(p.pendingLoadout);
      p.loadout = p.pendingLoadout;
      p.loadoutWire = loadoutToWire(p.loadout);
      p.weaponIdx = [
        weaponIndex(p.loadout.choice.primary),
        weaponIndex(p.loadout.choice.secondary),
      ];
      p.pendingLoadout = null;
    }
    p.sim = this.freshSim(p.team, p.ctx);
    p.frags = equipment.frag.perLife;
    p.smokes = equipment.smoke.perLife;
    p.throwArmed = false;
    p.alive = true;
    p.health = MAX_HEALTH;
    p.respawnTicks = 0;
    p.lifeId = (p.lifeId + 1) & 0xff;
    // History is kept: ticks while dead are recorded alive=false, so a rewind into the time
    // before this respawn never finds the player "alive at the spawn point".
    p.protectedUntil = this.tick + SPAWN_PROTECTION_TICKS;
  }

  /** New match: everyone back to a spawn, full health and ammo. */
  respawnAll(): void {
    this.grenades.clear();
    for (const p of this.players.values()) this.respawn(p);
  }

  /** New match: zero kills and deaths. */
  resetStats(): void {
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.headshots = 0;
      p.fragKills = 0;
      p.weaponKills.clear();
      p.aim = newAimStats();
    }
  }

  /** Eye position of a player (bots aim from here). */
  eyeOf(p: SimPlayer): Vec3 {
    return eyePosition(p.sim.move, this.ctx.movement);
  }

  /** True if nothing solid blocks the straight line between two points. */
  lineOfSight(from: Vec3, to: Vec3): boolean {
    const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) return true;
    const hit = this.ctx.movement.world.castRay(
      new this.rapier.Ray(
        { x: from[0], y: from[1], z: from[2] },
        { x: d[0] / len, y: d[1] / len, z: d[2] / len },
      ),
      len,
      true,
      this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    return hit === null && !this.grenades.smokeBlocks(from, to);
  }

  /** The shared simulation context (bots plan with the same world). */
  get context(): SimContext {
    return this.ctx;
  }

  // --- Grenades ---------------------------------------------------------------------------

  /**
   * G / Q pressed this tick (not held): throw along the view, if one is left. One throw per
   * tick (frag first), then a cooldown; keys held since spawn don't count (see throwArmed).
   * Throwing doesn't lock the gun (that would need client prediction of throws).
   */
  private maybeThrow(p: SimPlayer, before: SimState): void {
    const held = p.sim.move.prevButtons;
    const keys = Button.Lethal | Button.Tactical;
    if (!p.throwArmed) {
      if ((held & keys) === 0) p.throwArmed = true;
      return;
    }
    const pressed = held & ~before.move.prevButtons;
    if ((pressed & keys) === 0 || this.tick < p.nextThrowTick) return;
    const frag = (pressed & Button.Lethal) !== 0 && p.frags > 0;
    const smoke = !frag && (pressed & Button.Tactical) !== 0 && p.smokes > 0;
    if (!frag && !smoke) return;
    const def = frag ? equipment.frag : equipment.smoke;
    const eye = eyePosition(p.sim.move, this.ctx.movement);
    const dir = directionFromAngles(p.sim.move.yaw, p.sim.move.pitch);
    if (!this.grenades.throw(def, p.id, eye, dir, p.sim.move.velocity)) return; // world cap
    if (frag) p.frags--;
    else p.smokes--;
    p.nextThrowTick = this.tick + Math.round(def.cooldown * TICK_RATE);
    p.protectedUntil = 0; // attacking ends spawn protection
  }

  /**
   * A fuse ran out. Smoke: the cloud appears (clients draw it; bots can't see through it).
   * Frag: damage to enemies and the thrower (never teammates) with a clear line from the blast
   * to their chest, full within the inner radius, falling off linearly to the outer radius.
   */
  private detonate(d: Detonation): void {
    const kind = d.projectile.def.kind;
    this.events.push({ to: null, event: { type: 'explosion', kind, position: d.position } });
    const blast = d.projectile.def.explosion;
    const owner = this.players.get(d.projectile.ownerId);
    if (!blast || !owner) return;
    // Lift the blast point off the floor, but never through a ceiling right above it.
    const up = this.ctx.movement.world.castRay(
      new this.rapier.Ray(
        { x: d.position[0], y: d.position[1], z: d.position[2] },
        { x: 0, y: 1, z: 0 },
      ),
      0.15,
      true,
      this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const lift = up ? Math.max(0, up.timeOfImpact - 0.02) : 0.15;
    const at: Vec3 = [d.position[0], d.position[1] + lift, d.position[2]];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const self = p === owner;
      if (!self && p.team === owner.team) continue;
      const m = p.sim.move;
      const chest: Vec3 = [
        m.position[0],
        m.position[1] + capsuleHeight(this.tuning, m.crouching) * 0.6,
        m.position[2],
      ];
      const dist = Math.hypot(chest[0] - at[0], chest[1] - at[1], chest[2] - at[2]);
      if (dist > blast.outerRadius || !this.clearLine(at, chest)) continue;
      const t = Math.max(0, (dist - blast.innerRadius) / (blast.outerRadius - blast.innerRadius));
      let dmg = blast.maxDamage + (blast.minDamage - blast.maxDamage) * Math.min(1, t);
      if (self) dmg *= blast.selfMultiplier;
      for (const perk of p.loadout.perks) dmg *= perk.explosiveDamageTaken; // Flak Vest
      const amount = Math.round(dmg);
      if (amount > 0) this.damage(p, owner, amount, 'torso', KILL_SOURCE_FRAG, d.position);
    }
  }

  /**
   * Potentially visible set, per viewer and enemy: send the enemy if they are close (heard),
   * fired recently within earshot, or if any of a few lines of sight is clear of the map:
   * eye → head / chest / where they'll be in PVS_LEAD_S, and from where the viewer will be.
   * The lead covers a peek around a corner arriving before the snapshot does. Once sent, an
   * enemy stays sent for PVS_HOLD_TICKS, so edges don't flicker. Disable with `pvs = false`.
   */
  private shouldSend(viewer: SimPlayer, eye: Vec3, p: SimPlayer): boolean {
    if (!this.pvs) return true;
    if (this.tick <= (viewer.sendUntil.get(p.id) ?? -1)) return true;
    // A "hidden" answer is reused for a few ticks (snapshots go out every 2): the lead and the
    // hold already cover that much movement, and it halves the ray casts.
    if (this.tick < (viewer.hiddenUntil.get(p.id) ?? -1)) return false;
    const m = p.sim.move;
    const dx = m.position[0] - eye[0];
    const dz = m.position[2] - eye[2];
    const dist = Math.hypot(dx, dz);
    const heard =
      dist < PVS_HEAR_METRES ||
      (this.tick - p.lastShotTick < PVS_SHOT_HEARD_TICKS && dist < PVS_SHOT_HEARD_METRES);
    let visible = heard;
    if (!visible) {
      const h = capsuleHeight(this.tuning, m.crouching);
      const v = m.velocity;
      const vv = viewer.sim.move.velocity;
      const head: Vec3 = [m.position[0], m.position[1] + h * 0.9, m.position[2]];
      const chest: Vec3 = [m.position[0], m.position[1] + h * 0.55, m.position[2]];
      const ahead: Vec3 = [
        chest[0] + v[0] * PVS_LEAD_S,
        chest[1] + v[1] * PVS_LEAD_S,
        chest[2] + v[2] * PVS_LEAD_S,
      ];
      const eyeAhead: Vec3 = [
        eye[0] + vv[0] * PVS_LEAD_S,
        eye[1] + vv[1] * PVS_LEAD_S,
        eye[2] + vv[2] * PVS_LEAD_S,
      ];
      visible =
        this.clearLine(eye, head) ||
        this.clearLine(eye, chest) ||
        this.clearLine(eye, ahead) ||
        this.clearLine(eyeAhead, chest);
    }
    if (visible && !heard && !viewer.aim.visibleSince.has(p.id)) {
      viewer.aim.visibleSince.set(p.id, this.tick); // came into sight (reaction-time start)
    }
    if (visible) viewer.sendUntil.set(p.id, this.tick + PVS_HOLD_TICKS);
    else viewer.hiddenUntil.set(p.id, this.tick + PVS_RECHECK_TICKS);
    return visible;
  }

  /** Head and chest both behind smoke, as seen from `eye`. */
  private hiddenBySmoke(eye: Vec3, p: SimPlayer): boolean {
    if (!this.grenades.hasClouds) return false;
    const m = p.sim.move;
    const h = capsuleHeight(this.tuning, m.crouching);
    const head: Vec3 = [m.position[0], m.position[1] + h * 0.9, m.position[2]];
    const chest: Vec3 = [m.position[0], m.position[1] + h * 0.6, m.position[2]];
    return this.grenades.smokeBlocks(eye, head) && this.grenades.smokeBlocks(eye, chest);
  }

  /** Map-only line check (smoke doesn't stop a blast). */
  private clearLine(from: Vec3, to: Vec3): boolean {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    // One reused Ray: this runs hundreds of times per snapshot (anti-wallhack), no garbage.
    const ray = (this.lineRay ??= new this.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
    ray.origin.x = from[0];
    ray.origin.y = from[1];
    ray.origin.z = from[2];
    ray.dir.x = dx / len;
    ray.dir.y = dy / len;
    ray.dir.z = dz / len;
    return (
      this.ctx.movement.world.castRay(
        ray,
        len,
        true,
        this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
      ) === null
    );
  }
  private lineRay: InstanceType<Rapier['Ray']> | null = null;

  // --- Hitbox history ----------------------------------------------------------------------

  private recordHistory(): void {
    for (const p of this.players.values()) {
      p.history.push({
        tick: this.tick,
        position: p.sim.move.position,
        crouching: p.sim.move.crouching,
        alive: p.alive,
      });
      if (p.history.length > HISTORY_TICKS) p.history.shift();
    }
  }

  /** Where a player's hitboxes were at a (fractional) past tick. */
  poseAt(p: SimPlayer, tick: number): HistoryEntry | null {
    const h = p.history;
    if (h.length === 0) return null;
    if (tick <= h[0]!.tick) return h[0]!;
    const last = h[h.length - 1]!;
    if (tick >= last.tick) return last;
    let i = h.length - 2;
    while (i > 0 && h[i]!.tick > tick) i--;
    const a = h[i]!;
    const b = h[i + 1]!;
    const t = (tick - a.tick) / (b.tick - a.tick);
    return {
      tick,
      position: [
        a.position[0] + (b.position[0] - a.position[0]) * t,
        a.position[1] + (b.position[1] - a.position[1]) * t,
        a.position[2] + (b.position[2] - a.position[2]) * t,
      ],
      crouching: t < 0.5 ? a.crouching : b.crouching,
      alive: a.alive && b.alive,
    };
  }

  // --- Spawning ----------------------------------------------------------------------------

  private freshSim(team: number, ctx: SimContext): SimState {
    return { move: this.spawnState(team), weapon: createWeaponState(ctx.loadout) };
  }

  /**
   * Pick a team spawn (Phase 3): never one a living enemy can see if avoidable, otherwise the
   * one farthest from the nearest enemy. Ties rotate so teammates don't stack on one point.
   */
  private spawnState(team: number) {
    const spawns = this.map.spawns.filter((s) => s.team === team);
    const enemies = [...this.players.values()].filter((p) => p.team !== team && p.alive);
    const enemyEyes = enemies.map((e) => this.eyeOf(e)); // once, not per spawn
    const start = this.spawnCursor[team]!++;
    let best = spawns[start % spawns.length]!;
    let bestScore = -Infinity;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[(start + i) % spawns.length]!;
      const head: Vec3 = [s.position[0], s.position[1] + 1.6, s.position[2]];
      let nearest = 1000;
      let seen = false;
      enemies.forEach((e, k) => {
        const p = e.sim.move.position;
        const d = Math.hypot(p[0] - s.position[0], p[2] - s.position[2]);
        nearest = Math.min(nearest, d);
        // Map-only check: a smoke must not make a spawn next to an enemy look safe (review M2).
        if (!seen && d < 80 && this.clearLine(enemyEyes[k]!, head)) seen = true;
      });
      const score = nearest - (seen ? 10_000 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return createPlayerState(best.position, yawFromDegrees(best.yawDeg));
  }
}

function asLoadout(l: Loadout | readonly [Weapon, Weapon] | undefined): Loadout {
  if (!l) return defaultBuiltLoadout;
  if ('weapons' in l) return l;
  return buildLoadout({ primary: l[0].id, secondary: l[1].id });
}
