import { weaponIndex, type GameMap, type Movement, type Weapon } from '@sentinel/content';
import { NO_WEAPON, type EntityState, type GameEvent, type Snapshot } from '@sentinel/protocol';
import {
  MAX_PLAYERS_PER_MATCH,
  MAX_REWIND_MS,
  TICK_RATE,
  buildWorld,
  createMovementContext,
  createPlayerBody,
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
  /** Server bot: its input comes from `botInput` (set by the bot controller each tick). */
  bot: boolean;
  botInput: TickInput | null;
  /** This player's loadout (compiled weapons) and its catalog indices for the wire. */
  ctx: SimContext;
  loadout: [number, number];
  /** Chosen in the menu mid-match: applied at the next spawn, never mid-life. */
  pendingLoadout: readonly [Weapon, Weapon] | null;
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
  kills: number;
  deaths: number;
  history: HistoryEntry[];
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
  /** Default loadout context; each player has their own (SimPlayer.ctx). */
  private readonly ctx: SimContext;
  private readonly specs = new Map<string, WeaponSpec>();
  private readonly random: () => number;
  private spawnCursor = [0, 0];

  constructor(
    private readonly rapier: Rapier,
    private readonly map: GameMap,
    private readonly tuning: Movement,
    loadout: readonly [Weapon, Weapon],
    seed = 1,
  ) {
    const movementCtx = createMovementContext(rapier, buildWorld(rapier, expandMap(map)), tuning);
    this.ctx = { movement: movementCtx, loadout: [this.spec(loadout[0]), this.spec(loadout[1])] };
    this.random = createRng(seed);
  }

  /** Compiled weapons are shared between players (compiled once per weapon). */
  private spec(w: Weapon): WeaponSpec {
    let s = this.specs.get(w.id);
    if (!s) this.specs.set(w.id, (s = compileWeapon(w)));
    return s;
  }

  private contextFor(loadout: readonly [Weapon, Weapon]): SimContext {
    return { movement: this.ctx.movement, loadout: [this.spec(loadout[0]), this.spec(loadout[1])] };
  }

  /**
   * Choose a loadout (already validated with resolveLoadout). It takes effect at the player's
   * next spawn, so a weapon can't be swapped mid-fight and the client's prediction only ever
   * changes loadout together with a respawn reset.
   */
  setLoadout(id: number, loadout: readonly [Weapon, Weapon]): void {
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
      loadout?: readonly [Weapon, Weapon];
    } = {},
  ): SimPlayer {
    if (this.isFull) throw new Error('match is full');
    let id = 1;
    while (this.players.has(id)) id++;
    const [a, b] = this.teamCounts();
    const team = opts.team ?? (a <= b ? 0 : 1);
    const ctx = opts.loadout ? this.contextFor(opts.loadout) : this.ctx;
    const player: SimPlayer = {
      id,
      team,
      name: opts.name ?? `Player ${id}`,
      guestId: opts.guestId ?? null,
      bot: opts.bot ?? false,
      botInput: null,
      ctx,
      loadout: [weaponIndex(ctx.loadout[0].def.id), weaponIndex(ctx.loadout[1].def.id)],
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
      kills: 0,
      deaths: 0,
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
      const r = stepSim(p.sim, input, p.ctx, p.body);
      p.sim = r.state;
      if (r.shot) {
        p.protectedUntil = 0; // firing ends spawn protection
        p.shotCount = (p.shotCount + 1) & 0xff;
        shots.push({ shooter: p, shot: r.shot, viewTick: p.viewTick });
      }
      if (p.sim.move.position[1] < this.map.killY) this.kill(p, null, NO_WEAPON, false);
    }

    this.tick++;
    this.recordHistory();
    // Every shot fired this tick counts, even if its shooter was killed by an earlier shot in
    // this same loop: both players pulled the trigger while alive (fair trades, not join order).
    for (const s of shots) this.resolveShot(s.shooter, s.shot, s.viewTick);
    this.updateLife();
    this.lastTickMicros = (performance.now() - start) * 1000;
  }

  snapshotFor(id: number): Snapshot {
    const me = this.players.get(id);
    const entities: EntityState[] = [];
    for (const p of this.players.values()) {
      if (p.id === id) continue;
      const m = p.sim.move;
      entities.push({
        id: p.id,
        team: p.team,
        alive: p.alive,
        grounded: m.grounded,
        crouching: m.crouching,
        position: m.position,
        yaw: m.yaw,
        pitch: m.pitch,
        weapon: p.loadout[p.sim.weapon.slot],
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
            loadout: me.loadout,
            health: me.health,
            lifeId: me.lifeId,
            respawnTicks: me.respawnTicks,
          }
        : null,
      entities,
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
    const rewindTick = Math.max(this.tick - MAX_REWIND_TICKS, Math.min(this.tick, viewTick));
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
    for (const [victim, z] of byVictim) {
      // The zone that took most of the damage is the one reported (a blast with one stray
      // pellet in the head is not a headshot).
      const zone: HitZone =
        z.head >= z.torso && z.head >= z.limbs ? 'head' : z.torso >= z.limbs ? 'torso' : 'limbs';
      this.damage(victim, shooter, z.head + z.torso + z.limbs, zone, shooter.loadout[shot.slot]);
    }
  }

  private damage(
    victim: SimPlayer,
    attacker: SimPlayer,
    damage: number,
    zone: HitZone,
    weapon: number,
  ): void {
    if (!victim.alive || this.tick < victim.protectedUntil) return;
    victim.health = Math.max(this.noDeath ? 1 : 0, victim.health - damage);
    victim.lastDamageTick = this.tick;
    const killed = victim.health === 0;
    this.events.push({
      to: attacker.id,
      event: { type: 'hit', victim: victim.id, damage, zone, killed },
    });
    this.events.push({
      to: victim.id,
      event: {
        type: 'damaged',
        attacker: attacker.id,
        from: attacker.sim.move.position,
        health: victim.health,
      },
    });
    if (killed) this.kill(victim, attacker, weapon, zone === 'head');
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
      p.loadout = [weaponIndex(p.pendingLoadout[0].id), weaponIndex(p.pendingLoadout[1].id)];
      p.pendingLoadout = null;
    }
    p.sim = this.freshSim(p.team, p.ctx);
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
    for (const p of this.players.values()) this.respawn(p);
  }

  /** New match: zero kills and deaths. */
  resetStats(): void {
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
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
    return hit === null;
  }

  /** The shared simulation context (bots plan with the same world). */
  get context(): SimContext {
    return this.ctx;
  }

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
        if (!seen && d < 80 && this.lineOfSight(enemyEyes[k]!, head)) seen = true;
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
