import { Room, ServerError, type Client } from '@colyseus/core';
import { MessageType, PROTOCOL_VERSION, RELOAD_REQUIRED, encodeHello } from '@sentinel/protocol';
import { MAX_PLAYERS_PER_MATCH, TICK_RATE } from '@sentinel/shared';
import { isProtocolCompatible } from './protocol-check.ts';

/** HTTP-style status used when rejecting a client built for another protocol version. */
const RELOAD_REQUIRED_CODE = 426; // "Upgrade Required"

/**
 * Authoritative match room. Phase 0: accepts players and says hello.
 * The 60 Hz simulation loop and snapshots arrive in Phase 1.
 */
export class MatchRoom extends Room {
  override maxClients = MAX_PLAYERS_PER_MATCH;

  override onAuth(_client: Client, options: unknown): boolean {
    if (!isProtocolCompatible(options)) {
      throw new ServerError(RELOAD_REQUIRED_CODE, RELOAD_REQUIRED);
    }
    return true;
  }

  override onJoin(client: Client): void {
    console.log(`[match ${this.roomId}] join ${client.sessionId} (${this.clients.length} players)`);
    client.sendBytes(
      MessageType.Hello,
      encodeHello({ protocolVersion: PROTOCOL_VERSION, serverTickRate: TICK_RATE }),
    );
  }

  override onLeave(client: Client): void {
    console.log(`[match ${this.roomId}] leave ${client.sessionId}`);
  }
}
