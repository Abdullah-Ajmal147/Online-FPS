import { Client, type Room } from '@colyseus/sdk';
import { CONTENT_HASH, type LoadoutChoice, type LoadoutWire } from '@sentinel/content';
import {
  MessageType,
  PROTOCOL_VERSION,
  RELOAD_REQUIRED,
  decodeChat,
  decodeEvents,
  decodeHello,
  decodeMatchInfo,
  decodePing,
  decodeSnapshot,
  encodeChatSend,
  encodeInputCmd,
  encodePing,
  encodeSetLoadout,
  type ChatLine,
  type GameEvent,
  type Hello,
  type MatchInfo,
  type InputCmd,
  type Snapshot,
} from '@sentinel/protocol';
import { getStatus, setStatus } from './store.ts';
import { pickRegion, regions } from './regions.ts';
import { urlFromQuery } from './urls.ts';

/**
 * Game server to join: `?server=` in the page URL (development and tests; allowed hosts only
 * in production), else the region picked by `pickRegion` (invite, choice, ping).
 */
function serverFor(regionChoice: string): { url: string; region: string | null } {
  const fromQuery = urlFromQuery('server');
  if (fromQuery) return { url: fromQuery, region: null };
  const region = pickRegion(regions(), getStatus().regionPings, regionChoice, inviteRegion());
  return { url: region.url, region: region.id };
}

export interface NetHandlers {
  onHello(hello: Hello): void;
  onSnapshot(snapshot: Snapshot, arrivalMs: number): void;
  onEvents(events: GameEvent[]): void;
  onMatchInfo(info: MatchInfo): void;
  onChat(line: ChatLine): void;
  onDisconnect(): void;
}

const PING_INTERVAL_MS = 1000;

/** The match connection: binary messages over the Colyseus room's WebSocket. */
export class Connection {
  rttMs: number | null = null;
  private room: Room | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  async connect(
    handlers: NetHandlers,
    join: {
      name: string;
      token: string | null;
      loadout: LoadoutChoice;
      mode: string;
      region: string;
    },
  ): Promise<void> {
    const { name, token, loadout, mode } = join;
    const server = serverFor(join.region);
    const client = new Client(server.url);
    try {
      const options = {
        protocolVersion: PROTOCOL_VERSION,
        contentHash: CONTENT_HASH,
        name,
        ...loadout,
        mode,
        ...(token ? { token } : {}),
      };
      // Party invite link (?room=…&with=…): join the friend's match, on their team. If that
      // room is full or gone, fall back to any match.
      const invite = inviteFromUrl();
      let room: Room | undefined;
      if (invite) {
        try {
          room = await client.joinById(invite.room, { ...options, with: invite.with });
        } catch (err) {
          console.warn('[net] invite room unavailable, joining any match:', err);
        }
      }
      room ??= await joinWithPool(client, options);
      this.room = room;

      room.onMessage(MessageType.Hello, (payload: Uint8Array) => {
        const hello = decodeHello(payload);
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          setStatus({ net: { state: 'error', text: 'update required, please reload' } });
          void room.leave();
          return;
        }
        setStatus({
          net: { state: 'connected', text: `connected, protocol v${hello.protocolVersion}` },
          invite: hello.inviteToken
            ? inviteUrl(room.roomId, hello.inviteToken, server.region)
            : null,
          region: server.region,
        });
        handlers.onHello(hello);
      });

      room.onMessage(MessageType.Snapshot, (payload: Uint8Array) => {
        let snap: Snapshot;
        try {
          snap = decodeSnapshot(payload);
        } catch (err) {
          console.warn('[net] dropped a malformed snapshot:', err); // counts as lost
          return;
        }
        handlers.onSnapshot(snap, performance.now());
      });

      room.onMessage(MessageType.Events, (payload: Uint8Array) => {
        try {
          handlers.onEvents(decodeEvents(payload));
        } catch (err) {
          console.warn('[net] dropped malformed events:', err);
        }
      });

      room.onMessage(MessageType.Chat, (payload: Uint8Array) => {
        try {
          handlers.onChat(decodeChat(payload));
        } catch (err) {
          console.warn('[net] dropped malformed chat:', err);
        }
      });
      room.onMessage(MessageType.MatchInfo, (payload: Uint8Array) => {
        try {
          handlers.onMatchInfo(decodeMatchInfo(payload));
        } catch (err) {
          console.warn('[net] dropped malformed match info:', err);
        }
      });

      room.onMessage(MessageType.Pong, (payload: Uint8Array) => {
        const sent = decodePing(payload);
        this.rttMs = ((Math.floor(performance.now()) >>> 0) - sent) >>> 0;
      });

      this.pingTimer = setInterval(
        () => this.room?.sendBytes(MessageType.Ping, encodePing(performance.now())),
        PING_INTERVAL_MS,
      );

      room.onLeave((code: number) => {
        clearInterval(this.pingTimer);
        this.room = undefined;
        const text =
          code === 4403 ? 'removed from the match (banned)' : 'disconnected from the match';
        setStatus({ net: { state: 'error', text } });
        handlers.onDisconnect();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text =
        message === RELOAD_REQUIRED
          ? 'update required, please reload'
          : message.includes('banned')
            ? 'this account is banned from matches'
            : 'game server unreachable, try again';
      console.error('[net] join failed:', err);
      setStatus({ net: { state: 'error', text } });
    }
  }

  get connected(): boolean {
    return this.room !== undefined;
  }

  sendInput(cmd: InputCmd): void {
    this.room?.sendBytes(MessageType.InputCmd, encodeInputCmd(cmd));
  }

  sendChat(team: boolean, text: string): void {
    this.room?.sendBytes(MessageType.ChatSend, encodeChatSend({ team, text }));
  }

  /** Loadout for our next spawn (weapon catalog indices); the server validates it. */
  sendLoadout(loadout: LoadoutWire): void {
    this.room?.sendBytes(MessageType.SetLoadout, encodeSetLoadout(loadout));
  }
}

/** Invite parameters from this page's URL, if it was opened from an invite link. */
export function inviteFromUrl(): { room: string; with: string } | null {
  const q = new URLSearchParams(location.search);
  const room = q.get('room');
  const withId = q.get('with');
  const ok = (v: string | null): v is string => !!v && /^[A-Za-z0-9_-]{1,40}$/.test(v);
  return ok(room) && ok(withId) ? { room, with: withId } : null;
}

/** A link that brings a friend into this match, on this player's team (server-issued token). */
export function inviteUrl(roomId: string, token: string, region: string | null = null): string {
  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  url.searchParams.set('with', token);
  // Rooms live on one server: the friend must join the same region.
  if (region) url.searchParams.set('region', region);
  else url.searchParams.delete('region');
  return url.toString();
}

/** Region from an invite link (only with a room to join; checked against the list later). */
function inviteRegion(): string | null {
  if (!inviteFromUrl()) return null;
  const r = new URLSearchParams(location.search).get('region');
  return r && /^[a-z0-9-]{1,24}$/.test(r) ? r : null;
}

/**
 * joinOrCreate, following the server if it assigns another pool ("POOL:shadow"): moderated
 * players are matched with each other. A ban is reported as such.
 */
async function joinWithPool(client: Client, options: Record<string, unknown>): Promise<Room> {
  try {
    return await client.joinOrCreate('match', options);
  } catch (err) {
    const msg = String((err as { message?: unknown }).message ?? err);
    const reroute = /REROUTE:(\w*)/.exec(msg);
    if (reroute) {
      const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== 'pool'));
      return client.joinOrCreate('match', reroute[1] ? { ...rest, pool: reroute[1] } : rest);
    }
    if (msg.includes('BANNED'))
      throw new Error('This account is banned from matches.', { cause: err });
    throw err;
  }
}
