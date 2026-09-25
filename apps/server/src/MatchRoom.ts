import { Room, ServerError, type AuthContext, type Client } from '@colyseus/core';
import { RateLimiter, resolveApiSecret, verifyGuestToken } from '@sentinel/auth';
import { defaultLoadout, maps, modes, movement } from '@sentinel/content';
import {
  MessageType,
  PROTOCOL_VERSION,
  RELOAD_REQUIRED,
  decodeInputCmd,
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
import { BotController } from './bots/controller.ts';
import { FakeLag, presetFromEnv } from './fakeLag.ts';
import { Match, type MatchSummary } from './match.ts';
import { TeamDeathmatch } from './mode.ts';
import { sanitizeName } from './names.ts';
import { isProtocolCompatible } from './protocol-check.ts';
import { MatchSim } from './sim.ts';
import { PUMP_INTERVAL_MS, TickLoop } from './tickLoop.ts';

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

interface Seat {
  playerId: number;
  ackServerTick: number;
  badMessages: number;
  lastPingMs: number;
}

/**
 * Joins per IP (Phase 4 task 10): burst 20, then one per second. Stops join floods while
 * leaving room for many players behind one IP (schools, cafés, mobile carriers).
 */
const joinLimit = new RateLimiter(20, 1);
const API_SECRET = resolveApiSecret(process.env);

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
  /** Called with each finished match (MatchRoom logs it; Phase 4 posts it to the API). */
  static onMatchEnd: ((summary: MatchSummary) => void) | null = null;

  override async onCreate(): Promise<void> {
    const preset = presetFromEnv(process.env.SENTINEL_LAG);
    if (preset) {
      this.lag = new FakeLag(preset, Date.now() & 0xffff);
      console.warn(`[match] fake lag ON: ${JSON.stringify(preset)}`);
    }
    // SENTINEL_MAP picks the map (tests use the open "arena").
    this.mapId = process.env.SENTINEL_MAP ?? 'relay-yard';
    const map = maps[this.mapId];
    if (!map) {
      throw new Error(
        `SENTINEL_MAP: unknown map "${this.mapId}" (have ${Object.keys(maps).join(', ')})`,
      );
    }
    const rapier = await initPhysics();
    this.sim = new MatchSim(rapier, map, movement, defaultLoadout, Date.now() & 0xffffffff);
    if (process.env.SENTINEL_TEST_NO_DEATH) {
      this.sim.noDeath = true;
      console.warn('[match] TEST MODE: players cannot die (SENTINEL_TEST_NO_DEATH)');
    }

    const tdm = modes['team-deathmatch']!;
    this.match = new Match(
      this.sim,
      new TeamDeathmatch(tdm),
      {
        warmupSeconds: envNumber('SENTINEL_WARMUP_SECONDS', 8),
        countdownSeconds: 4,
        liveSeconds: envNumber('SENTINEL_MATCH_SECONDS', tdm.timeLimitSeconds),
        resultsSeconds: envNumber('SENTINEL_RESULTS_SECONDS', 12),
      },
      this.mapId,
    );
    this.match.onMatchEnd = (summary) => {
      // Phase 3 task 9: one JSON line per match, for logs and (Phase 4) the API.
      console.log(`[match-summary] ${JSON.stringify(summary)}`);
      MatchRoom.onMatchEnd?.(summary);
    };

    if (process.env.SENTINEL_BOTS !== '0') {
      const level = (process.env.SENTINEL_BOT_DIFFICULTY ?? 'normal') as keyof typeof DIFFICULTIES;
      this.bots = new BotController(this.sim, map, DIFFICULTIES[level] ?? DIFFICULTIES.normal);
      this.bots.fill();
    }

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
  override onAuth(
    _client: Client,
    options: unknown,
    context: AuthContext,
  ): { guestId: string | null } {
    if (!isProtocolCompatible(options)) {
      throw new ServerError(RELOAD_REQUIRED_CODE, RELOAD_REQUIRED);
    }
    if (!joinLimit.take(context.ip ?? 'unknown'))
      throw new ServerError(429, 'too many joins, try again shortly');
    const token = (options as { token?: unknown }).token;
    return { guestId: verifyGuestToken(token, API_SECRET) };
  }

  override onJoin(client: Client, options?: { name?: unknown }): void {
    // Keep teams even: pick the smaller team, and swap out a bot on it if the match is full.
    const team = this.bots ? this.bots.teamForHuman() : undefined;
    if (this.bots && team !== undefined) this.bots.makeRoomFor(team);
    const player = this.sim.addPlayer({
      name: sanitizeName(options?.name),
      guestId: this.uniqueGuest(
        (client.auth as { guestId?: string | null } | undefined)?.guestId ?? null,
      ),
      ...(team === undefined ? {} : { team }),
    });
    this.seats.set(client.sessionId, {
      playerId: player.id,
      ackServerTick: 0,
      badMessages: 0,
      lastPingMs: -Infinity,
    });
    console.log(
      `[match ${this.roomId}] join "${player.name}" as player ${player.id} (team ${player.team})`,
    );
    client.sendBytes(
      MessageType.Hello,
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        serverTickRate: TICK_RATE,
        playerId: player.id,
        team: player.team,
        mapId: this.mapId,
      }),
    );
    this.sendMatchInfo();
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
    console.log(`[match ${this.roomId}] leave ${client.sessionId}`);
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
    try {
      this.tickUnsafe();
      this.consecutiveTickErrors = 0;
    } catch (err) {
      this.tickErrors++;
      console.error(`[match ${this.roomId}] tick ${this.sim.tick} failed:`, err);
      if (++this.consecutiveTickErrors >= 30) {
        console.error(`[match ${this.roomId}] 30 failing ticks in a row: closing this room`);
        void this.disconnect();
      }
    }
  }

  private tickErrors = 0;
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

  /** Fast-path message to a client, through fake lag when it's on. */
  private outbound(client: Client, type: number, bytes: Uint8Array): void {
    const send = () => {
      if (this.seats.has(client.sessionId)) client.sendBytes(type, bytes);
    };
    if (this.lag) this.lag.pass(`${client.sessionId}:out`, send, true);
    else send();
  }
}
