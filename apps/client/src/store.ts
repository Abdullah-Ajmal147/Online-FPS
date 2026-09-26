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

export interface ChatEntry {
  key: number;
  name: string;
  /** Sender's team (0/1), for the name colour. */
  team: number;
  /** Sent to the sender's team only. */
  teamOnly: boolean;
  text: string;
  at: number;
  /** What muting this sender stores: their player code, or `id:<n>` for this session only. */
  muteKey: string;
}

/**
 * The chat UI talks to the running game through this (main.ts wires it once the game starts).
 */
export const chatBridge: { send: (team: boolean, text: string) => void; opened: () => void } = {
  send: () => undefined,
  /** Called when the chat box opens: stop any held movement keys. */
  opened: (): void => undefined,
};

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
  /** Killcam replay running: who killed us, with what. */
  killcam: { killer: string; weapon: string } | null;
  /** performance.now() of the last confirmed hit, and what it was. */
  hitAt: number;
  hitKind: 'hit' | 'head' | 'kill' | 'predicted';
  /** Hits the server confirmed this match (predicted markers not counted). */
  confirmedHits: number;
  /** Damage directions (degrees, 0 = ahead, clockwise) with the time they arrived. */
  damage: { key: number; angle: number; at: number }[];
  killFeed: KillFeedEntry[];
  /** Kill confirmations and medals, newest last (shown ~2.5 s). */
  announcements: { key: number; kind: 'kill' | 'medal'; text: string; sub: string; at: number }[];
}

export interface MatchHud {
  phase: 'warmup' | 'countdown' | 'live' | 'ended';
  /** Private match: invite / Join only; team switching allowed. */
  private: boolean;
  secondsLeft: number;
  scoreLimit: number;
  /** [my team, enemy team] */
  scores: [number, number];
  myTeam: number;
  /** Mode id (e.g. 'domination') and its capture points (empty in Team Deathmatch). */
  mode: string;
  points: { id: string; owner: number; control: number }[];
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
    /** Public player code ('' for bots and players without a profile). */
    code: string;
  }[];
}

export interface ClientStatus {
  backend: 'WebGPU' | 'WebGL 2' | 'starting';
  /** Name of the map being played (changes with the rotation). */
  mapName: string;
  /** Id of that map (briefings). */
  mapId: string;
  /** DEPLOY pressed: we are in (or joining) a match. False on the main menu. */
  inMatch: boolean;
  /** The server has placed our soldier (first own snapshot of this match connection). */
  spawned: boolean;
  net: { state: 'idle' | 'connecting' | 'connected' | 'error'; text: string };
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
  /** lastMatch id when the current match went live: a newer one is this match's XP. */
  xpBaseline: string | null;
  /** Party invite link for the current match (null until connected). */
  invite: string | null;
  /** Recent chat lines, oldest first (muted players already left out). */
  chat: ChatEntry[];
  /** Measured round trip per region id (null: unreachable); empty until measured. */
  regionPings: Record<string, number | null>;
  /** Region of the current match connection (null when not connected). */
  region: string | null;
}

type Listener = (status: ClientStatus) => void;

let status: ClientStatus = {
  backend: 'starting',
  mapName: '',
  mapId: '',
  inMatch: false,
  spawned: false,
  net: { state: 'idle', text: 'not in a match' },
  playing: false,
  player: null,
  netStats: null,
  fps: 0,
  combat: null,
  match: null,
  profile: null,
  xpBaseline: null,
  invite: null,
  chat: [],
  regionPings: {},
  region: null,
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
