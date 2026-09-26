import { randomBytes } from 'node:crypto';
import { Room, ServerError, type AuthContext, type Client } from '@colyseus/core';
import {
  RateLimiter,
  resolveApiSecret,
  verifyGuestToken,
  publicCode,
  ipHash,
  shadowPoolId,
} from '@sentinel/auth';
import {
  defaultLoadout,
  MAP_ROTATION,
  maps,
  modes,
  movement,
  NEW_PLAYER,
  attachmentCatalog,
  buildLoadout,
  cleanChat,
  loadoutFromWire,
  perkCatalog,
  weaponCatalog,
  type Access,
} from '@sentinel/content';
import {
  MessageType,
  PROTOCOL_VERSION,
  RELOAD_REQUIRED,
  decodeInputCmd,
  CHAT_SEND_MAX_BYTES,
  decodeChatSend,
  decodeSetLoadout,
  encodeChat,
  decodeSnapshotAck,
  encodeEvents,
  encodeHello,
  encodeMatchInfo,
  encodeSnapshot,
  type GameEvent,
} from '@sentinel/protocol';
import {
  MAX_PLAYERS_PER_MATCH,
  TICKS_PER_SNAPSHOT,
  TICK_RATE,
  initPhysics,
} from '@sentinel/shared';
import { DIFFICULTIES } from './bots/brain.ts';
import { BotController, prewarmNav } from './bots/controller.ts';
import { FakeLag, presetFromEnv } from './fakeLag.ts';
import { Match, type MatchSummary } from './match.ts';
import { createMode } from './mode.ts';
import { mapRotationFromEnv } from './mapRotation.ts';
import { partyTeamFor } from './party.ts';
import { sanitizeName } from './names.ts';
import { isProtocolCompatible } from './protocol-check.ts';
import { MatchSim } from './sim.ts';
import { PUMP_INTERVAL_MS, TickLoop } from './tickLoop.ts';
import { counters, liveRooms, log, tickWindow } from './ops.ts';

/** HTTP-style status used when rejecting a client built for another protocol version. */
const RELOAD_REQUIRED_CODE = 426; // "Upgrade Required"
/** Malformed messages tolerated per client before we disconnect it. */
const MAX_BAD_MESSAGES = 20;
/** Normal traffic is 60 inputs + 1 ping per second; a 15-input catch-up burst still fits. */
const MAX_MESSAGES_PER_SECOND = 150;
/** Pings closer together than this are ignored (the client pings once a second). */
const MIN_PING_INTERVAL_MS = 400;
/** Scoreboard/clock updates, on top of immediate updates when the phase changes. */
const MATCH_INFO_EVERY_TICKS = TICK_RATE / 2;

/** SetLoadout rate limit: menu clicks are slow; anything faster is noise or abuse. */
const MIN_LOADOUT_INTERVAL_MS = 250;

interface Seat {
  playerId: number;
  ackServerTick: number;
  badMessages: number;
  lastPingMs: number;
  lastLoadoutMs: number;
  guestId: string | null;
  /** The player's unlocks (refreshed at each new match). */
  access: Access;
  /** Random party invite token (in Hello; friends join with it). */
  inviteToken: string;
  /** Keyed hash of the player's IP (moderation lookups). */
  ipHash: string;
  /** Chat rate-limit key: the guest profile, else the IP (a reconnect doesn't reset it). */
  chatKey: string;
  /** The player lets friends see this match and join it (Settings; default on). */
  allowJoin: boolean;
  lastSwitchMs: number;
}

/** One room's humans, for friends' Join buttons (index.ts sends it to the API, signed). */
export interface RoomPresence {
  region: string;
  roomId: string;
  mode: string;
  map: string;
  private: boolean;
  players: { guestId: string; inviteToken: string; allowJoin: boolean }[];
}

/** This server's region id (the client's region list uses the same ids). */
const REGION = /^[a-z0-9-]{1,24}$/.test(process.env.SENTINEL_REGION ?? '')
  ? process.env.SENTINEL_REGION!
  : 'default';
/** Presence heartbeat; the API forgets a room after ~2.5 missed beats. */
const PRESENCE_EVERY_MS = 20_000;

/**
 * Private matches: each one builds a physics world and bots, so creating them is limited per
 * IP (burst 3, then one per 30 s) and per process (SENTINEL_MAX_PRIVATE_ROOMS, default 30).
 * Checked in the static onAuth, which runs before a room exists.
 */
const privateCreateLimit = new RateLimiter(3, 1 / 30);
const MAX_PRIVATE_ROOMS = Math.max(0, Number(process.env.SENTINEL_MAX_PRIVATE_ROOMS ?? 30) || 0);
let privateRooms = 0;
/** Team switches (private matches) at most every 2 s per player. */
const MIN_SWITCH_INTERVAL_MS = 2000;

/**
 * Joins per IP (Phase 4 task 10): burst 20, then one per second. Stops join floods while
 * leaving room for many players behind one IP (schools, cafés, mobile carriers).
 */
const joinLimit = new RateLimiter(20, 1);
/** Chat per player: a burst of 4 lines, then one every 1.5 s. */
const chatLimit = new RateLimiter(4, 1 / 1.5);
const API_SECRET = resolveApiSecret(process.env);
/** Opaque id of the shadow pool (moderated players' rooms). */
const SHADOW_POOL = shadowPoolId(API_SECRET);

const envNumber = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * Authoritative match room. The server simulates everyone at 60 Hz from their inputs only
 * (CLAUDE.md rule 1), runs the match loop (warm-up → countdown → live → results), fills empty
 * slots with bots, and sends each client a snapshot every 2nd tick (30 Hz).
 *
 * Environment (all optional): SENTINEL_MAP, SENTINEL_BOTS (0 = off), SENTINEL_BOT_DIFFICULTY
 * (easy|normal|hard), SENTINEL_MATCH_SECONDS, SENTINEL_WARMUP_SECONDS, SENTINEL_RESULTS_SECONDS,
 * and the test-only SENTINEL_LAG / SENTINEL_TEST_NO_DEATH.
 */
export class MatchRoom extends Room {
  /** Humans only; bots are not clients. */
  override maxClients = MAX_PLAYERS_PER_MATCH;
  /** Colyseus disconnects a client that sends more than this (default is unlimited). */
  override maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;
  private sim!: MatchSim;
  private match!: Match;
  private bots: BotController | null = null;
  private loop!: TickLoop;
  private seats = new Map<string, Seat>();
  /** Set by `pnpm dev:lag --preset <name>` (SENTINEL_LAG). Never on in production. */
  private lag: FakeLag | null = null;
  private mapId = 'greybox';
  private rotation: string[] = [];
  private rotationIndex = 0;
  /** Called with each finished match (MatchRoom logs it; Phase 4 posts it to the API). */
  static onMatchEnd: ((summary: MatchSummary) => Promise<unknown>) | null = null;
  /** What a player has unlocked, or null if unknown (index.ts wires the API; tests: unknown). */
  static fetchAccess: (guestId: string | null, ipHash: string) => Promise<Access | null> =
    async () => null;
  /** Where presence reports go (index.ts: the API). Tests leave it off. */
  static onPresence: ((report: RoomPresence) => void) | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceBeat: ReturnType<typeof setInterval> | undefined;
  /** Private match (not in matchmaking; invite or Join button only). */
  private isPrivateMatch = false;
  private modeId = 'team-deathmatch';

  /** Matchmaking pool: 'shadow' rooms only hold shadow-banned players (index.ts filterBy). */
  private pool: 'normal' | 'shadow' = 'normal';

  /**
   * Runs before matchmaking, even before a room is created (Colyseus static hook): limits who
   * may create private rooms. Every other check is in the instance onAuth below. It must
   * return plain `true`: returning auth data would make Colyseus skip the instance onAuth.
   */
  static override async onAuth(
    _token: unknown,
    options: unknown,
    context: AuthContext,
  ): Promise<true> {
    if ((options as { private?: unknown } | null)?.private === true) {
      if (privateRooms >= MAX_PRIVATE_ROOMS)
        throw new ServerError(503, 'private matches are full right now, try again soon');
      if (!privateCreateLimit.take(context.ip ?? 'unknown'))
        throw new ServerError(429, 'too many private matches, wait a moment');
    }
    return true;
  }

  override async onCreate(options?: {
    pool?: unknown;
    mode?: unknown;
    /** Private match (Play screen): not in matchmaking; invite link or Join button only. */
    private?: unknown;
    /** Private match: the first map (then the usual rotation). */
    map?: unknown;
    /** Private match: fill empty slots with bots. */
    bots?: unknown;
  }): Promise<void> {
    // Only two pools exist: none (normal) or the opaque shadow id. Anything else is refused
    // here, before a physics world and bots are built (no private-room or room-spam tricks).
    if (options?.pool !== undefined && options.pool !== SHADOW_POOL) {
      throw new ServerError(400, 'unknown pool');
    }
    this.pool = options?.pool === SHADOW_POOL ? 'shadow' : 'normal';
    const preset = presetFromEnv(process.env.SENTINEL_LAG);
    if (preset) {
      this.lag = new FakeLag(preset, Date.now() & 0xffff);
      log.warn('fake lag ON (test setting)', { preset });
    }
    this.rotation = mapRotationFromEnv(process.env);
    if (options?.private === true) {
      this.isPrivateMatch = true;
      privateRooms++;
      await this.setPrivate(true);
      // The creator's map first, if it's a real map (anything else keeps the rotation).
      if (typeof options.map === 'string' && MAP_ROTATION.includes(options.map))
        this.rotation = [options.map, ...MAP_ROTATION.filter((m) => m !== options.map)];
    }
    this.mapId = this.rotation[0]!;
    const map = maps[this.mapId]!;
    const rapier = await initPhysics();
    this.sim = new MatchSim(rapier, map, movement, defaultLoadout, Date.now() & 0xffffffff);
    if (process.env.SENTINEL_TEST_NO_DEATH) {
      this.sim.noDeath = true;
      log.warn('TEST MODE: players cannot die (SENTINEL_TEST_NO_DEATH)');
    }

    // Playlist: the join's `mode` (Play screen), unless the server pins one (SENTINEL_MODE).
    const modeId =
      process.env.SENTINEL_MODE ?? (typeof options?.mode === 'string' ? options.mode : '');
    const modeDef = Object.hasOwn(modes, modeId) ? modes[modeId]! : modes['team-deathmatch']!;
    this.modeId = modeDef.id;
    this.match = new Match(
      this.sim,
      createMode(modeDef),
      {
        warmupSeconds: envNumber('SENTINEL_WARMUP_SECONDS', 8),
        countdownSeconds: 4,
        liveSeconds: envNumber('SENTINEL_MATCH_SECONDS', modeDef.timeLimitSeconds),
        resultsSeconds: envNumber('SENTINEL_RESULTS_SECONDS', 12),
      },
      this.mapId,
    );
    this.match.isPrivate = this.isPrivateMatch;
    this.match.onNextMatch = () => this.rotateMap();
    this.match.onMatchEnd = (summary) => {
      // Phase 3 task 9: one JSON line per match, for logs and (Phase 4) the API.
      counters.matches.inc();
      log.info('match ended', { room: this.roomId, summary });
      // Once the API has the result, re-read unlocks (this match may have levelled someone up).
      void Promise.resolve(MatchRoom.onMatchEnd?.(summary)).finally(() => this.refreshAccess());
    };

    const wantBots = this.isPrivateMatch ? options?.bots !== false : true;
    if (process.env.SENTINEL_BOTS !== '0' && wantBots) {
      const level = (process.env.SENTINEL_BOT_DIFFICULTY ?? 'normal') as keyof typeof DIFFICULTIES;
      for (const id of this.rotation) prewarmNav(rapier, movement, maps[id]!);
      this.bots = new BotController(this.sim, map, DIFFICULTIES[level] ?? DIFFICULTIES.normal);
      this.bots.fill();
    }

    liveRooms.add(this.gauges);
    this.presenceBeat = setInterval(() => this.reportPresence(), PRESENCE_EVERY_MS);
    this.loop = new TickLoop(() => this.tick());
    this.setSimulationInterval(() => this.loop.pump(), PUMP_INTERVAL_MS);

    this.onMessageBytes(MessageType.InputCmd, (client: Client, bytes: Uint8Array) =>
      this.inbound(client, () => this.onInputCmd(client, bytes)),
    );

    // Echo pings straight back so the client can measure round-trip time (rate-limited).
    this.onMessageBytes(MessageType.Ping, (client: Client, bytes: Uint8Array) => {
      const seat = this.seats.get(client.sessionId);
      const now = performance.now();
      if (!seat || bytes.length !== 4 || now - seat.lastPingMs < MIN_PING_INTERVAL_MS) return;
      seat.lastPingMs = now;
      this.inbound(client, () => this.outbound(client, MessageType.Pong, bytes));
    });

    // Loadout for the next spawn. Untrusted: indices must name a weapon (else it counts as a bad
    // message), buildLoadout drops misfitting picks, and it only ever applies at a respawn.
    // At most a few changes per second; extra ones are ignored.
    this.onMessageBytes(MessageType.SetLoadout, (client: Client, bytes: Uint8Array) => {
      const seat = this.seats.get(client.sessionId);
      const now = performance.now();
      if (!seat || now - seat.lastLoadoutMs < MIN_LOADOUT_INTERVAL_MS) return;
      seat.lastLoadoutMs = now;
      this.inboundReliable(client, () => {
        try {
          const msg = decodeSetLoadout(bytes);
          const known =
            weaponCatalog[msg.primary] &&
            weaponCatalog[msg.secondary] &&
            msg.attachments.every((i) => attachmentCatalog[i]) &&
            msg.perks.every((i) => perkCatalog[i]);
          if (!known) throw new RangeError('unknown catalog index');
          this.sim.setLoadout(seat.playerId, loadoutFromWire(msg, seat.access));
        } catch {
          if (++seat.badMessages > MAX_BAD_MESSAGES) client.leave(4400);
        }
      });
    });

    // Chat: rate-limited per player, cleaned and filtered here (never trusted from the client),
    // then sent to everyone, or to the sender's team only.
    this.onMessageBytes(MessageType.ChatSend, (client: Client, bytes: Uint8Array) => {
      const seat = this.seats.get(client.sessionId);
      if (!seat) return;
      // Size and rate checks before any decoding (cheap rejection of floods).
      if (bytes.length > CHAT_SEND_MAX_BYTES) {
        if (++seat.badMessages > MAX_BAD_MESSAGES) client.leave(4400);
        return;
      }
      if (!chatLimit.take(seat.chatKey)) return;
      this.inboundReliable(client, () => {
        let msg;
        try {
          msg = decodeChatSend(bytes);
        } catch {
          if (++seat.badMessages > MAX_BAD_MESSAGES) client.leave(4400);
          return;
        }
        const text = cleanChat(msg.text);
        const from = this.sim.players.get(seat.playerId);
        if (!text || !from) return;
        counters.chat.inc();
        const line = encodeChat({ from: from.id, team: msg.team, text });
        for (const c of this.clients) {
          const s = this.seats.get(c.sessionId);
          const to = s && this.sim.players.get(s.playerId);
          if (to && (!msg.team || to.team === from.team)) this.reliable(c, MessageType.Chat, line);
        }
      });
    });

    // Private matches: switch to the other team (at most every 2 s, only if it has room).
    this.onMessageBytes(MessageType.SwitchTeam, (client: Client, bytes: Uint8Array) => {
      const seat = this.seats.get(client.sessionId);
      const now = performance.now();
      if (!seat || !this.isPrivateMatch || now - seat.lastSwitchMs < MIN_SWITCH_INTERVAL_MS) return;
      if (bytes.length !== 0) {
        if (++seat.badMessages > MAX_BAD_MESSAGES) client.leave(4400);
        return;
      }
      seat.lastSwitchMs = now;
      this.inboundReliable(client, () => this.switchTeam(client, seat));
    });

    // Standalone ack (normally the ack rides on InputCmd).
    this.onMessageBytes(MessageType.SnapshotAck, (client: Client, bytes: Uint8Array) => {
      const seat = this.seats.get(client.sessionId);
      if (!seat) return;
      try {
        const tick = decodeSnapshotAck(bytes);
        seat.ackServerTick = Math.max(seat.ackServerTick, Math.min(tick, this.sim.tick));
      } catch {
        if (++seat.badMessages > MAX_BAD_MESSAGES) client.leave(4400);
      }
    });
  }

  /**
   * Runs before joining: protocol check, per-IP join rate limit, and the guest token. A valid
   * token becomes `client.auth.guestId` (progression); no token is fine, it just earns no XP.
   */
  override async onAuth(
    _client: Client,
    options: unknown,
    context: AuthContext,
  ): Promise<{ guestId: string | null; access: Access; ip: string | null }> {
    if (!isProtocolCompatible(options)) {
      counters.rejectedJoins.inc();
      throw new ServerError(RELOAD_REQUIRED_CODE, RELOAD_REQUIRED);
    }
    if (!joinLimit.take(context.ip ?? 'unknown')) {
      counters.rejectedJoins.inc();
      throw new ServerError(429, 'too many joins, try again shortly');
    }
    const token = (options as { token?: unknown }).token;
    const guestId = verifyGuestToken(token, API_SECRET);
    // Unlocks come from the API (server-reported progress), never from the client.
    // Moderation covers the profile and the connection (IP, as a keyed hash): a banned player
    // can't come back as a new guest or without a token from the same connection.
    const ipHashValue = ipHash(API_SECRET, context.ip ?? 'unknown');
    const access = (await MatchRoom.fetchAccess(guestId, ipHashValue)) ?? NEW_PLAYER;
    if (access.status === 'banned') {
      counters.rejectedJoins.inc();
      throw new ServerError(4403, 'BANNED');
    }
    // Shadow pool (Phase 7 task 6): shadow-banned players only ever play each other. A join
    // into the wrong pool is refused with an opaque reroute id the client follows.
    const pool = access.status === 'shadow' ? 'shadow' : 'normal';
    if (pool !== this.pool)
      throw new ServerError(4409, `REROUTE:${pool === 'shadow' ? SHADOW_POOL : ''}`);
    // Private match: after its creator, only with the invite token of someone inside (a room
    // id alone isn't enough, e.g. from a shared screenshot of the address bar).
    if (this.isPrivateMatch && this.seats.size > 0) {
      const token = (options as { with?: unknown }).with;
      if (!this.seatByInvite(token)) throw new ServerError(4404, 'PRIVATE');
    }
    return { guestId, access, ip: context.ip ?? null };
  }

  override onJoin(
    client: Client,
    options?: {
      name?: unknown;
      primary?: unknown;
      secondary?: unknown;
      attachments?: unknown;
      perks?: unknown;
      /** Party invite: the session id of the friend who shared the link (same team). */
      with?: unknown;
      /** Friends may see and join this match (Settings). */
      allowJoin?: unknown;
    },
  ): void {
    // Keep teams even: pick the smaller team, and swap out a bot on it if the match is full.
    // Joining through a friend's invite puts you on their team if it has room for a human.
    const team =
      this.partyTeam(options?.with) ?? (this.bots ? this.bots.teamForHuman() : undefined);
    if (this.bots && team !== undefined) this.bots.makeRoomFor(team);
    const auth = client.auth as
      { guestId?: string | null; access?: Access; ip?: string | null } | undefined;
    const guestId = this.uniqueGuest(auth?.guestId ?? null);
    const access = auth?.access ?? NEW_PLAYER;
    const player = this.sim.addPlayer({
      name: sanitizeName(options?.name),
      guestId,
      code: guestId ? publicCode(API_SECRET, guestId) : '',
      level: access.level,
      ...(team === undefined ? {} : { team }),
      loadout: buildLoadout(
        {
          primary: options?.primary,
          secondary: options?.secondary,
          attachments: options?.attachments,
          perks: options?.perks,
        },
        access,
      ),
    });
    this.seats.set(client.sessionId, {
      playerId: player.id,
      ackServerTick: 0,
      badMessages: 0,
      lastPingMs: -Infinity,
      lastLoadoutMs: -Infinity,
      guestId,
      access,
      inviteToken: randomBytes(9).toString('base64url'),
      ipHash: ipHash(API_SECRET, auth?.ip ?? 'unknown'),
      chatKey: guestId ?? `ip:${auth?.ip ?? client.sessionId}`,
      allowJoin: options?.allowJoin !== false,
      lastSwitchMs: -Infinity,
    });
    this.presenceSoon();
    counters.joins.inc();
    log.info('player joined', {
      room: this.roomId,
      player: player.id,
      team: player.team,
      name: player.name,
      guest: player.guestId !== null,
    });
    client.sendBytes(
      MessageType.Hello,
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        serverTickRate: TICK_RATE,
        playerId: player.id,
        team: player.team,
        mapId: this.mapId,
        inviteToken: this.seats.get(client.sessionId)?.inviteToken ?? '',
      }),
    );
    this.sendMatchInfo();
  }

  /**
   * The team of the player whose invite token this is, if they're still here, their team has
   * room, and joining keeps teams fair: a party may put its team at most MAX_PARTY_LEAD
   * humans ahead of the other (so a leaked link can't stack one side).
   */
  private partyTeam(token: unknown): number | undefined {
    const seat = this.seatByInvite(token);
    const host = seat && this.sim.players.get(seat.playerId);
    if (!host) return undefined;
    const humans: [number, number] = [0, 0];
    for (const p of this.sim.players.values()) if (!p.bot) humans[p.team as 0 | 1]++;
    return partyTeamFor(humans, host.team, modes['team-deathmatch']!.playersPerTeam);
  }

  private seatByInvite(token: unknown): Seat | undefined {
    if (typeof token !== 'string' || token.length === 0 || token.length > 32) return undefined;
    return [...this.seats.values()].find((s) => s.inviteToken === token);
  }

  /**
   * Private matches: to the other team if it has room for another human. With bots, one of
   * its bots makes way and a new bot fills the side the player left, so teams stay 6 v 6.
   */
  private switchTeam(client: Client, seat: Seat): void {
    const p = this.sim.players.get(seat.playerId);
    if (!p) return;
    const target = 1 - p.team;
    const perTeam = modes[this.modeId]?.playersPerTeam ?? 6;
    let humans = 0;
    for (const q of this.sim.players.values()) if (!q.bot && q.team === target) humans++;
    if (humans >= perTeam) return;
    this.bots?.makeRoomFor(target);
    this.sim.switchTeam(p.id, target);
    this.bots?.fill();
    log.info('switched team', { room: this.roomId, player: p.id, team: target });
    this.sendHello(client, p.id, target); // the client learns its new team
    this.sendMatchInfo();
  }

  /** Re-read every player's unlocks from the API (async; applies to later loadout changes). */
  private refreshAccess(): void {
    for (const seat of this.seats.values()) {
      if (!seat.guestId) continue;
      // If the API can't answer, the player keeps what they had.
      void MatchRoom.fetchAccess(seat.guestId, seat.ipHash).then((access) => {
        if (!access) return;
        seat.access = access;
        // Banned since joining: out now. (Shadow status applies from the next join.)
        if (access.status === 'banned') {
          this.clients.find((c) => this.seats.get(c.sessionId) === seat)?.leave(4403);
        }
      });
    }
  }

  /** Next map in the rotation (between matches): rebuild the world, tell every client. */
  private rotateMap(): string {
    if (this.rotation.length < 2) return this.mapId;
    this.rotationIndex = (this.rotationIndex + 1) % this.rotation.length;
    const next = maps[this.rotation[this.rotationIndex]!];
    if (!next) return this.mapId;
    this.mapId = next.id;
    this.sim.changeMap(next);
    this.bots?.setMap(next);
    log.info('map rotated', { room: this.roomId, map: next.id });
    this.presenceSoon();
    // Hello again: the client loads the new map (same player id and team).
    for (const client of this.clients) {
      const seat = this.seats.get(client.sessionId);
      const p = seat && this.sim.players.get(seat.playerId);
      if (p) this.sendHello(client, p.id, p.team);
    }
    return this.mapId;
  }

  private sendHello(client: Client, playerId: number, team: number): void {
    this.reliable(
      client,
      MessageType.Hello,
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        serverTickRate: TICK_RATE,
        playerId,
        team,
        mapId: this.mapId,
        inviteToken: this.seats.get(client.sessionId)?.inviteToken ?? '',
      }),
    );
  }

  /** One seat per guest earns XP: a second tab with the same guest plays without progression. */
  private uniqueGuest(guestId: string | null): string | null {
    if (!guestId) return null;
    for (const p of this.sim.players.values()) if (p.guestId === guestId) return null;
    return guestId;
  }

  override onLeave(client: Client): void {
    const seat = this.seats.get(client.sessionId);
    if (seat) {
      this.match.playerLeaving(seat.playerId); // keeps their stats in this match's result
      this.sim.removePlayer(seat.playerId);
    }
    this.seats.delete(client.sessionId);
    this.lag?.forget(client.sessionId);
    this.bots?.fill();
    this.presenceSoon();
    log.info('player left', { room: this.roomId, session: client.sessionId });
  }

  private onInputCmd(client: Client, bytes: Uint8Array): void {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    let cmd;
    try {
      cmd = decodeInputCmd(bytes);
    } catch {
      if (++seat.badMessages > MAX_BAD_MESSAGES) client.leave(4400);
      return;
    }
    seat.ackServerTick = Math.max(seat.ackServerTick, Math.min(cmd.ackServerTick, this.sim.tick));
    const queue = this.sim.players.get(seat.playerId)?.queue;
    for (const input of cmd.inputs) queue?.push(input);
  }

  /**
   * One server tick. Never lets an exception escape: Colyseus does not catch errors in the
   * simulation interval, and an uncaught error would stop the whole process (every match).
   * A failing tick is logged and skipped; repeated failures close just this room.
   */
  private tick(): void {
    const start = performance.now();
    try {
      this.tickUnsafe();
      this.consecutiveTickErrors = 0;
      const ms = performance.now() - start;
      tickWindow.add(ms);
      counters.ticks.inc();
      if (ms > 4) counters.slowTicks.inc();
    } catch (err) {
      this.tickErrors++;
      counters.tickErrors.inc();
      log.error('tick failed', { room: this.roomId, tick: this.sim.tick, err });
      if (++this.consecutiveTickErrors >= 30) {
        log.error('30 failing ticks in a row: closing this room', { room: this.roomId });
        void this.disconnect();
      }
    }
  }

  private tickErrors = 0;
  /** Player counts for the /metrics gauges. */
  private readonly gauges = {
    humans: () => this.seats.size,
    bots: () => this.bots?.count ?? 0,
  };

  /** Report presence shortly (joins and leaves often come in bursts). */
  private presenceSoon(): void {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.reportPresence();
    }, 1000);
  }

  private reportPresence(empty = false): void {
    if (!MatchRoom.onPresence) return;
    const players = empty
      ? []
      : [...this.seats.values()]
          .filter((s): s is Seat & { guestId: string } => s.guestId !== null)
          .map((s) => ({ guestId: s.guestId, inviteToken: s.inviteToken, allowJoin: s.allowJoin }));
    MatchRoom.onPresence({
      region: REGION,
      roomId: this.roomId,
      mode: this.modeId,
      map: this.mapId,
      private: this.isPrivateMatch,
      players,
    });
  }

  override onDispose(): void {
    clearInterval(this.presenceBeat);
    clearTimeout(this.presenceTimer);
    this.reportPresence(true); // everyone here is gone
    if (this.isPrivateMatch) privateRooms--;
    liveRooms.delete(this.gauges);
    log.info('room closed', { room: this.roomId, tickErrors: this.tickErrors });
  }
  private consecutiveTickErrors = 0;

  private tickUnsafe(): void {
    this.bots?.think();
    this.sim.step();
    const phaseChanged = this.match.update();
    this.sendEvents();
    if (phaseChanged || this.sim.tick % MATCH_INFO_EVERY_TICKS === 0) this.sendMatchInfo();
    if (this.sim.tick % TICKS_PER_SNAPSHOT !== 0) return;
    for (const client of this.clients) {
      const seat = this.seats.get(client.sessionId);
      if (!seat) continue;
      this.outbound(
        client,
        MessageType.Snapshot,
        encodeSnapshot(this.sim.snapshotFor(seat.playerId)),
      );
    }
  }

  /** Kills to everyone, hits to the shooter, damage to the victim. Reliable (never dropped). */
  private sendEvents(): void {
    if (this.sim.events.length === 0) return;
    for (const client of this.clients) {
      const seat = this.seats.get(client.sessionId);
      if (!seat) continue;
      const mine: GameEvent[] = this.sim.events
        .filter((e) => e.to === null || e.to === seat.playerId)
        .map((e) => e.event);
      if (mine.length > 0) this.reliable(client, MessageType.Events, encodeEvents(mine));
    }
  }

  /** Phase, clock, scores and scoreboard to everyone. Reliable. */
  private sendMatchInfo(): void {
    const bytes = encodeMatchInfo(this.match.info());
    for (const client of this.clients) this.reliable(client, MessageType.MatchInfo, bytes);
  }

  /** Reliable message to a client (delayed but never dropped by fake lag). */
  private reliable(client: Client, type: number, bytes: Uint8Array): void {
    const send = () => {
      if (this.seats.has(client.sessionId)) client.sendBytes(type, bytes);
    };
    if (this.lag) this.lag.pass(`${client.sessionId}:out`, send, false);
    else send();
  }

  /** Fast-path message from a client, through fake lag when it's on. */
  private inbound(client: Client, handle: () => void): void {
    if (this.lag) this.lag.pass(`${client.sessionId}:in`, handle, true);
    else handle();
  }

  /** Delayed by fake lag but never dropped (chat, loadouts: a real WebSocket never drops). */
  private inboundReliable(client: Client, handle: () => void): void {
    if (this.lag) this.lag.pass(`${client.sessionId}:in`, handle, false);
    else handle();
  }

  /** Fast-path message to a client, through fake lag when it's on. */
  private outbound(client: Client, type: number, bytes: Uint8Array): void {
    const send = () => {
      if (this.seats.has(client.sessionId)) client.sendBytes(type, bytes);
    };
    if (this.lag) this.lag.pass(`${client.sessionId}:out`, send, true);
    else send();
  }
}
