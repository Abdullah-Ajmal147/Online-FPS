/** Tiny observable store shared by the game code and the Preact HUD. */
import type { Profile } from './profile.ts';
export interface PlayerDebug {
  position: readonly [number, number, number];
  speed: number;
  grounded: boolean;
  crouching: boolean;
  sliding: boolean;
}

export interface NetStats {
  rttMs: number | null;
  /** Percentage of own-state snapshots that caused a prediction correction. */
  correctionPct: number;
  lastErrorCm: number;
  snapshotLossPct: number;
  serverTickMs: number;
  inputQueueDepth: number;
  interpDelayMs: number;
  remotePlayers: number;
}

export interface KillFeedEntry {
  key: number;
  killer: string;
  killerTeam: number;
  victim: string;
  victimTeam: number;
  weapon: string;
  headshot: boolean;
}

export interface CombatHud {
  alive: boolean;
  health: number;
  weaponName: string;
  ammo: number;
  reserve: number;
  reloading: boolean;
  /** Grenades left this life. */
  frags: number;
  smokes: number;
  respawnSeconds: number;
  killedBy: string | null;
  /** performance.now() of the last confirmed hit, and what it was. */
  hitAt: number;
  hitKind: 'hit' | 'head' | 'kill' | 'predicted';
  /** Damage directions (degrees, 0 = ahead, clockwise) with the time they arrived. */
  damage: { key: number; angle: number; at: number }[];
  killFeed: KillFeedEntry[];
  /** Kill confirmations and medals, newest last (shown ~2.5 s). */
  announcements: { key: number; kind: 'kill' | 'medal'; text: string; sub: string; at: number }[];
}

export interface MatchHud {
  phase: 'warmup' | 'countdown' | 'live' | 'ended';
  secondsLeft: number;
  scoreLimit: number;
  /** [my team, enemy team] */
  scores: [number, number];
  myTeam: number;
  /** 'win' | 'loss' | 'draw' once ended. */
  result: 'win' | 'loss' | 'draw' | null;
  mvp: string | null;
  players: {
    id: number;
    name: string;
    team: number;
    bot: boolean;
    kills: number;
    deaths: number;
    me: boolean;
  }[];
}

export interface ClientStatus {
  backend: 'WebGPU' | 'WebGL 2' | 'starting';
  /** Name of the map being played (changes with the rotation). */
  mapName: string;
  net: { state: 'connecting' | 'connected' | 'error'; text: string };
  /** True while the mouse is captured and the player is in control. */
  playing: boolean;
  /** Null until the local simulation has started. */
  player: PlayerDebug | null;
  /** Null in offline practice mode. */
  netStats: NetStats | null;
  fps: number;
  combat: CombatHud | null;
  match: MatchHud | null;
  /** Guest level/XP from the API, null until loaded (or if the API is down). */
  profile: Profile | null;
}

type Listener = (status: ClientStatus) => void;

let status: ClientStatus = {
  backend: 'starting',
  mapName: '',
  net: { state: 'connecting', text: 'connecting…' },
  playing: false,
  player: null,
  netStats: null,
  fps: 0,
  combat: null,
  match: null,
  profile: null,
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
