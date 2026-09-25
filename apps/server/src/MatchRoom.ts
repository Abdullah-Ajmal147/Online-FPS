import { Room, ServerError, type Client } from '@colyseus/core';
import { maps, movement } from '@sentinel/content';
import {
  MessageType,
  PROTOCOL_VERSION,
  RELOAD_REQUIRED,
  decodeInputCmd,
  encodeHello,
  encodeSnapshot,
} from '@sentinel/protocol';
import {
  MAX_PLAYERS_PER_MATCH,
  TICKS_PER_SNAPSHOT,
  TICK_RATE,
  initPhysics,
} from '@sentinel/shared';
import { isProtocolCompatible } from './protocol-check.ts';
import { MatchSim } from './sim.ts';
import { PUMP_INTERVAL_MS, TickLoop } from './tickLoop.ts';

/** HTTP-style status used when rejecting a client built for another protocol version. */
const RELOAD_REQUIRED_CODE = 426; // "Upgrade Required"

/** Malformed messages tolerated per client before we disconnect it. */
const MAX_BAD_MESSAGES = 20;

interface Seat {
  playerId: number;
  ackServerTick: number;
  badMessages: number;
}

/**
 * Authoritative match room. The server simulates everyone at 60 Hz from their inputs only
 * (CLAUDE.md rule 1) and sends each client a snapshot every 2nd tick (30 Hz).
 */
export class MatchRoom extends Room {
  override maxClients = MAX_PLAYERS_PER_MATCH;
  private sim!: MatchSim;
  private loop!: TickLoop;
  private seats = new Map<string, Seat>();

  override async onCreate(): Promise<void> {
    const rapier = await initPhysics();
    this.sim = new MatchSim(rapier, maps.greybox!, movement);
    this.loop = new TickLoop(() => this.tick());
    this.setSimulationInterval(() => this.loop.pump(), PUMP_INTERVAL_MS);

    this.onMessageBytes(MessageType.InputCmd, (client: Client, bytes: Uint8Array) => {
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
    });

    // Echo pings straight back so the client can measure round-trip time.
    this.onMessageBytes(MessageType.Ping, (client: Client, bytes: Uint8Array) => {
      if (bytes.length === 4) client.sendBytes(MessageType.Pong, bytes);
    });
  }

  override onAuth(_client: Client, options: unknown): boolean {
    if (!isProtocolCompatible(options)) {
      throw new ServerError(RELOAD_REQUIRED_CODE, RELOAD_REQUIRED);
    }
    return true;
  }

  override onJoin(client: Client): void {
    const player = this.sim.addPlayer();
    this.seats.set(client.sessionId, { playerId: player.id, ackServerTick: 0, badMessages: 0 });
    console.log(
      `[match ${this.roomId}] join ${client.sessionId} as player ${player.id} (team ${player.team})`,
    );
    client.sendBytes(
      MessageType.Hello,
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        serverTickRate: TICK_RATE,
        playerId: player.id,
      }),
    );
  }

  override onLeave(client: Client): void {
    const seat = this.seats.get(client.sessionId);
    if (seat) this.sim.removePlayer(seat.playerId);
    this.seats.delete(client.sessionId);
    console.log(`[match ${this.roomId}] leave ${client.sessionId}`);
  }

  private tick(): void {
    this.sim.step();
    if (this.sim.tick % TICKS_PER_SNAPSHOT !== 0) return;
    for (const client of this.clients) {
      const seat = this.seats.get(client.sessionId);
      if (!seat) continue;
      client.sendBytes(MessageType.Snapshot, encodeSnapshot(this.sim.snapshotFor(seat.playerId)));
    }
  }
}
