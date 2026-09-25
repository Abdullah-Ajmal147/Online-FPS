import { Client, type Room } from '@colyseus/sdk';
import {
  MessageType,
  PROTOCOL_VERSION,
  RELOAD_REQUIRED,
  decodeHello,
  decodePing,
  decodeSnapshot,
  encodeInputCmd,
  encodePing,
  type Hello,
  type InputCmd,
  type Snapshot,
} from '@sentinel/protocol';
import { setStatus } from './store.ts';

function serverUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const protocol = location.protocol === 'https:' ? 'https' : 'http';
  return `${protocol}://${location.hostname}:2567`;
}

export interface NetHandlers {
  onHello(hello: Hello): void;
  onSnapshot(snapshot: Snapshot, arrivalMs: number): void;
}

const PING_INTERVAL_MS = 1000;

/** The match connection: binary messages over the Colyseus room's WebSocket. */
export class Connection {
  rttMs: number | null = null;
  private room: Room | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  async connect(handlers: NetHandlers): Promise<void> {
    const client = new Client(serverUrl());
    try {
      const room = await client.joinOrCreate('match', { protocolVersion: PROTOCOL_VERSION });
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
        handlers.onSnapshot(decodeSnapshot(payload), performance.now());
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
        setStatus({ net: { state: 'error', text: 'disconnected' } });
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
