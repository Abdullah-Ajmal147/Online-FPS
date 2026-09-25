/** Tiny observable store shared by the game code and the Preact HUD. */
export interface PlayerDebug {
  position: readonly [number, number, number];
  speed: number;
  grounded: boolean;
  crouching: boolean;
  sliding: boolean;
}

export interface ClientStatus {
  backend: 'WebGPU' | 'WebGL 2' | 'starting';
  net: { state: 'connecting' | 'connected' | 'error'; text: string };
  /** True while the mouse is captured and the player is in control. */
  playing: boolean;
  /** Null until the local simulation has started. */
  player: PlayerDebug | null;
}

type Listener = (status: ClientStatus) => void;

let status: ClientStatus = {
  backend: 'starting',
  net: { state: 'connecting', text: 'connecting…' },
  playing: false,
  player: null,
};
const listeners = new Set<Listener>();

export function getStatus(): ClientStatus {
  return status;
}

export function setStatus(patch: Partial<ClientStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

/**
 * Calls `listener` right away with the current status, then on every change.
 * The immediate call matters: Preact runs useEffect after paint (and not at all in
 * hidden tabs until later), so updates can happen before the HUD subscribes.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}
