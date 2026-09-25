import { Client } from '@colyseus/sdk';
import { MessageType, PROTOCOL_VERSION, RELOAD_REQUIRED, decodeHello } from '@sentinel/protocol';
import { setStatus } from './store.ts';

function serverUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const protocol = location.protocol === 'https:' ? 'https' : 'http';
  return `${protocol}://${location.hostname}:2567`;
}

/** Join the match room and wait for the server's binary Hello before reporting "connected". */
export async function connect(): Promise<void> {
  const client = new Client(serverUrl());
  try {
    const room = await client.joinOrCreate('match', { protocolVersion: PROTOCOL_VERSION });

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
    });

    room.onLeave(() => {
      setStatus({ net: { state: 'error', text: 'disconnected' } });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const text =
      message === RELOAD_REQUIRED ? 'update required, please reload' : 'server unreachable';
    console.error('[net] join failed:', err);
    setStatus({ net: { state: 'error', text } });
  }
}
