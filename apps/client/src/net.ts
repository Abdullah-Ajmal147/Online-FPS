import { Client, type Room } from '@colyseus/sdk';
import {
  MessageType,
  PROTOCOL_VERSION,
  RELOAD_REQUIRED,
  decodeEvents,
  decodeHello,
  decodeMatchInfo,
  decodePing,
  decodeSnapshot,
  encodeInputCmd,
  encodePing,
  type GameEvent,
  type Hello,
  type MatchInfo,
  type InputCmd,
  type Snapshot,
} from '@sentinel/protocol';
import { setStatus } from './store.ts';

/**
 * Game server to join: `?server=` in the page URL (tests, and later region picking), then the
 * build-time VITE_SERVER_URL, then the same host on port 2567.
 */
function serverUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('server');
  if (fromQuery && /^https?:\/\//.test(fromQuery)) return fromQuery;
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const protocol = location.protocol === 'https:' ? 'https' : 'http';
  return `${protocol}://${location.hostname}:2567`;
}

export interface NetHandlers {
  onHello(hello: Hello): void;
  onSnapshot(snapshot: Snapshot, arrivalMs: number): void;
  onEvents(events: GameEvent[]): void;
  onMatchInfo(info: MatchInfo): void;
  onDisconnect(): void;
}

const PING_INTERVAL_MS = 1000;

/** The match connection: binary messages over the Colyseus room's WebSocket. */
export class Connection {
  rttMs: number | null = null;
  private room: Room | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  async connect(handlers: NetHandlers, name: string, token: string | null): Promise<void> {
    const client = new Client(serverUrl());
    try {
      const room = await client.joinOrCreate('match', {
        protocolVersion: PROTOCOL_VERSION,
        name,
        ...(token ? { token } : {}),
      });
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

      room.onLeave(() => {
        clearInterval(this.pingTimer);
        this.room = undefined;
        setStatus({ net: { state: 'error', text: 'disconnected (practice mode)' } });
        handlers.onDisconnect();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text =
        message === RELOAD_REQUIRED
          ? 'update required, please reload'
          : 'server unreachable (practice mode)';
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
}
