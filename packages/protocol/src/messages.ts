import {
  INPUT_REDUNDANCY,
  type EntityState,
  type OwnState,
  type SequencedInput,
  type Vec3,
  type WeaponState,
} from '@sentinel/shared';
import { BinaryReader, BinaryWriter } from './binary.ts';
import { dequantizePosition, quantizePosition } from './quantize.ts';

/**
 * Numeric ids for binary messages sent with Colyseus sendBytes/onMessageBytes.
 * Every change to any layout below must bump PROTOCOL_VERSION.
 */
export const MessageType = {
  /**
   * Server → client after join, and again whenever the map rotates (v8): the client loads the
   * map and keeps counting input seqs.
   */
  Hello: 1,
  /** Client → server every tick: the newest inputs (with redundancy) + snapshot ack. */
  InputCmd: 2,
  /** Server → client at 30 Hz. */
  Snapshot: 3,
  /** Client → server: standalone snapshot ack (normally it rides on InputCmd). */
  SnapshotAck: 4,
  /** Client → server, echoed back as Pong: round-trip time measurement. */
  Ping: 5,
  Pong: 6,
  /** Server → client: kills, hit confirmations, damage taken. Never dropped. */
  Events: 7,
  /** Server → client: match phase, clock, scores, scoreboard. Never dropped. */
  MatchInfo: 8,
  /** Client → server: loadout for the next spawn (weapon catalog indices). Never dropped. */
  SetLoadout: 9,
} as const;

export type { SequencedInput, OwnState };

// ---------------------------------------------------------------------------
// Hello
// ---------------------------------------------------------------------------

export interface Hello {
  protocolVersion: number;
  serverTickRate: number;
  /** Entity id of the receiving player (appears in other clients' snapshots). */
  playerId: number;
  /** 0 = Aegis Directive, 1 = Ember Syndicate. */
  team: number;
  /** Map the server runs (id in packages/content maps); the client loads the same one. */
  mapId: string;
}

export function encodeHello(msg: Hello): Uint8Array {
  return new BinaryWriter(8)
    .u16(msg.protocolVersion)
    .u8(msg.serverTickRate)
    .u8(msg.playerId)
    .u8(msg.team)
    .string(msg.mapId)
    .finish();
}

export function decodeHello(bytes: Uint8Array): Hello {
  const r = new BinaryReader(bytes);
  return {
    protocolVersion: r.u16(),
    serverTickRate: r.u8(),
    playerId: r.u8(),
    team: r.u8(),
    mapId: r.string(),
  };
}

// ---------------------------------------------------------------------------
// InputCmd
// ---------------------------------------------------------------------------

export interface InputCmd {
  /** Newest serverTick the client has received (the snapshot ack). */
  ackServerTick: number;
  /** Consecutive inputs, oldest first; the last one is new, the others are resent in case of loss. */
  inputs: SequencedInput[];
}

const INPUT_BYTES = 12;

/**
 * Layout: ackServerTick u32, count u8, firstSeq u32, then per input:
 * buttons u16, yaw u16, pitch i16, weaponSlot u8, viewTick u32 + u8 fraction (1/256 tick).
 * Seqs are consecutive.
 */
export function encodeInputCmd(msg: InputCmd): Uint8Array {
  const { inputs } = msg;
  if (inputs.length < 1 || inputs.length > INPUT_REDUNDANCY) {
    throw new RangeError(`InputCmd carries 1..${INPUT_REDUNDANCY} inputs, got ${inputs.length}`);
  }
  const w = new BinaryWriter(9 + inputs.length * INPUT_BYTES);
  w.u32(msg.ackServerTick).u8(inputs.length).u32(inputs[0]!.seq);
  inputs.forEach((input, i) => {
    if (input.seq !== inputs[0]!.seq + i) throw new RangeError('InputCmd seqs must be consecutive');
    const view = Math.max(0, input.viewTick);
    const whole = Math.floor(view);
    w.u16(input.buttons).u16(input.yaw).i16(input.pitch).u8(input.weaponSlot);
    w.u32(whole).u8(Math.min(255, Math.floor((view - whole) * 256)));
  });
  return w.finish();
}

/** Decodes untrusted client bytes: throws on malformed input, never trusts the count. */
export function decodeInputCmd(bytes: Uint8Array): InputCmd {
  const r = new BinaryReader(bytes);
  const ackServerTick = r.u32();
  const count = r.u8();
  if (count < 1 || count > INPUT_REDUNDANCY) throw new RangeError(`bad InputCmd count ${count}`);
  const firstSeq = r.u32();
  // Seqs must stay u32 end to end (they come back in snapshots as lastProcessedSeq).
  if (firstSeq + count - 1 > 0xffffffff) throw new RangeError('InputCmd seq overflow');
  const inputs: SequencedInput[] = [];
  for (let i = 0; i < count; i++) {
    const buttons = r.u16();
    const yaw = r.u16();
    const pitch = r.i16();
    const weaponSlot = r.u8();
    const viewTick = r.u32() + r.u8() / 256;
    inputs.push({ seq: firstSeq + i, buttons, yaw, pitch, weaponSlot, viewTick });
  }
  if (r.remaining !== 0) throw new RangeError('trailing bytes in InputCmd');
  return { ackServerTick, inputs };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface OwnSnapshot {
  sim: OwnState;
  /**
   * The loadout the server simulates us with (catalog indices). The client builds the same
   * weapons from it and predicts with exactly those; it changes only when we (re)spawn.
   */
  loadout: LoadoutWire;
  health: number;
  /** Increments each time we (re)spawn; a change means "reset prediction to this state". */
  lifeId: number;
  /** 0 while alive; otherwise ticks until respawn. */
  respawnTicks: number;
  /** Grenades left this life. */
  frags: number;
  smokes: number;
}

/** A thrown grenade, or a smoke cloud once released (server-simulated, drawn by clients). */
export interface ProjectileState {
  id: number;
  kind: 'frag' | 'smoke';
  /** Smoke only: the cloud is out. */
  cloud: boolean;
  position: Vec3;
}

/** Other players in a snapshot. Positions are int16 at 1/64 m on the wire (ADR 0004). */
export type { EntityState };

export interface Snapshot {
  serverTick: number;
  /** Last input seq the server applied for the receiving player (0 = none yet). */
  lastProcessedSeq: number;
  /** Inputs waiting in the server's queue for this player; the client paces itself on it. */
  inputQueueDepth: number;
  /** Server simulation time of the last tick, microseconds (debug overlay). */
  serverTickMicros: number;
  own: OwnSnapshot | null;
  entities: EntityState[];
  projectiles: ProjectileState[];
}

const OWN_GROUNDED = 1;
const OWN_CROUCHING = 2;
const ENT_GROUNDED = 1;
const ENT_CROUCHING = 2;
const ENT_ALIVE = 4;
const PROJ_CLOUD = 0x80;

function writeWeapon(w: BinaryWriter, s: WeaponState): void {
  w.u8(s.slot);
  for (const a of s.ammo) w.u8(a.ammo).u16(a.reserve);
  w.u8(s.cooldownTicks).u8(s.reloadTicks).u8(s.switchTicks).u8(s.adsTicks).u8(s.shotIndex);
  w.i16(s.recoilPitch).i16(s.recoilYaw).u16(s.bloom);
}

function readWeapon(r: BinaryReader): WeaponState {
  const slot = r.u8() === 1 ? 1 : 0;
  const a0 = { ammo: r.u8(), reserve: r.u16() };
  const a1 = { ammo: r.u8(), reserve: r.u16() };
  return {
    slot,
    ammo: [a0, a1],
    cooldownTicks: r.u8(),
    reloadTicks: r.u8(),
    switchTicks: r.u8(),
    adsTicks: r.u8(),
    shotIndex: r.u8(),
    recoilPitch: r.i16(),
    recoilYaw: r.i16(),
    bloom: r.u16(),
  };
}

function writeOwn(w: BinaryWriter, own: OwnSnapshot): void {
  const m = own.sim.move;
  for (const v of m.position) w.f32(v);
  for (const v of m.velocity) w.f32(v);
  w.u8(m.slideTicks).u8(m.slideCooldownTicks);
  w.u8((m.grounded ? OWN_GROUNDED : 0) | (m.crouching ? OWN_CROUCHING : 0));
  w.u16(m.prevButtons);
  writeWeapon(w, own.sim.weapon);
  writeLoadout(w, own.loadout);
  w.u8(own.health)
    .u8(own.lifeId & 0xff)
    .u8(own.respawnTicks)
    .u8(own.frags)
    .u8(own.smokes);
}

function readOwn(r: BinaryReader): OwnSnapshot {
  const position: Vec3 = [r.f32(), r.f32(), r.f32()];
  const velocity: Vec3 = [r.f32(), r.f32(), r.f32()];
  const slideTicks = r.u8();
  const slideCooldownTicks = r.u8();
  const flags = r.u8();
  const prevButtons = r.u16();
  const weapon = readWeapon(r);
  const loadout = readLoadout(r);
  return {
    loadout,
    sim: {
      move: {
        position,
        velocity,
        slideTicks,
        slideCooldownTicks,
        grounded: (flags & OWN_GROUNDED) !== 0,
        crouching: (flags & OWN_CROUCHING) !== 0,
        prevButtons,
      },
      weapon,
    },
    health: r.u8(),
    lifeId: r.u8(),
    respawnTicks: r.u8(),
    frags: r.u8(),
    smokes: r.u8(),
  };
}

const clampI16 = (v: number) => Math.max(-0x8000, Math.min(0x7fff, v));

/**
 * Layout: serverTick u32, lastProcessedSeq u32, inputQueueDepth u8, serverTickMicros u16,
 * hasOwn u8, [own: move 29 + weapon 18 + loadout 4–10 + health/lifeId/respawn 3 + grenades 2 = 54 bytes], entityCount u8,
 * entities × 15 bytes (id, team, flags, x/y/z i16 at 1/64 m, yaw u16, pitch i16, weapon, shots).
 * then projectileCount u8, projectiles × 8 bytes (id, kind|cloud, x/y/z i16).
 * Full snapshots, no delta compression (ADR 0004); 12 players stay under 10 KB/s.
 */
export function encodeSnapshot(msg: Snapshot): Uint8Array {
  const w = new BinaryWriter(96 + msg.entities.length * 15 + msg.projectiles.length * 8);
  w.u32(msg.serverTick).u32(msg.lastProcessedSeq).u8(Math.min(255, msg.inputQueueDepth));
  w.u16(Math.min(0xffff, Math.round(msg.serverTickMicros)));
  w.u8(msg.own ? 1 : 0);
  if (msg.own) writeOwn(w, msg.own);
  w.u8(msg.entities.length);
  for (const e of msg.entities) {
    w.u8(e.id).u8(e.team);
    w.u8(
      (e.grounded ? ENT_GROUNDED : 0) |
        (e.crouching ? ENT_CROUCHING : 0) |
        (e.alive ? ENT_ALIVE : 0),
    );
    for (const v of e.position) w.i16(clampI16(quantizePosition(v)));
    w.u16(e.yaw)
      .i16(e.pitch)
      .u8(e.weapon)
      .u8(e.shotCount & 0xff);
  }
  w.u8(msg.projectiles.length);
  for (const p of msg.projectiles) {
    w.u8(p.id).u8((p.kind === 'smoke' ? 1 : 0) | (p.cloud ? PROJ_CLOUD : 0));
    for (const v of p.position) w.i16(clampI16(quantizePosition(v)));
  }
  return w.finish();
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const r = new BinaryReader(bytes);
  const serverTick = r.u32();
  const lastProcessedSeq = r.u32();
  const inputQueueDepth = r.u8();
  const serverTickMicros = r.u16();
  const own = r.u8() ? readOwn(r) : null;
  const count = r.u8();
  const entities: EntityState[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.u8();
    const team = r.u8();
    const flags = r.u8();
    const position: Vec3 = [
      dequantizePosition(r.i16()),
      dequantizePosition(r.i16()),
      dequantizePosition(r.i16()),
    ];
    entities.push({
      id,
      team,
      grounded: (flags & ENT_GROUNDED) !== 0,
      crouching: (flags & ENT_CROUCHING) !== 0,
      alive: (flags & ENT_ALIVE) !== 0,
      position,
      yaw: r.u16(),
      pitch: r.i16(),
      weapon: r.u8(),
      shotCount: r.u8(),
    });
  }
  const projectiles: ProjectileState[] = [];
  const projectileCount = r.u8();
  for (let i = 0; i < projectileCount; i++) {
    const id = r.u8();
    const flags = r.u8();
    projectiles.push({
      id,
      kind: (flags & 1) === 1 ? 'smoke' : 'frag',
      cloud: (flags & PROJ_CLOUD) !== 0,
      position: [
        dequantizePosition(r.i16()),
        dequantizePosition(r.i16()),
        dequantizePosition(r.i16()),
      ],
    });
  }
  return {
    serverTick,
    lastProcessedSeq,
    inputQueueDepth,
    serverTickMicros,
    own,
    entities,
    projectiles,
  };
}

// ---------------------------------------------------------------------------
// SetLoadout
// ---------------------------------------------------------------------------

/**
 * A loadout as catalog indices (@sentinel/content: weaponCatalog, attachmentCatalog,
 * perkCatalog). Layout: primary u8, secondary u8, n u8 + n attachments, m u8 + m perks.
 */
export interface LoadoutWire {
  primary: number;
  secondary: number;
  attachments: number[];
  perks: number[];
}

/** At most this many attachments / perks on the wire (content allows 3 of each). */
export const MAX_LOADOUT_LIST = 3;

function writeLoadout(w: BinaryWriter, l: LoadoutWire): void {
  w.u8(l.primary).u8(l.secondary);
  for (const list of [l.attachments, l.perks]) {
    if (list.length > MAX_LOADOUT_LIST) throw new RangeError('loadout list too long');
    w.u8(list.length);
    for (const i of list) w.u8(i);
  }
}

function readLoadout(r: BinaryReader): LoadoutWire {
  const primary = r.u8();
  const secondary = r.u8();
  const lists: number[][] = [];
  for (let k = 0; k < 2; k++) {
    const n = r.u8();
    if (n > MAX_LOADOUT_LIST) throw new RangeError('loadout list too long');
    const list: number[] = [];
    for (let i = 0; i < n; i++) list.push(r.u8());
    lists.push(list);
  }
  return { primary, secondary, attachments: lists[0]!, perks: lists[1]! };
}

/** Client → server: the loadout for our next spawn. */
export type SetLoadout = LoadoutWire;

export function encodeSetLoadout(msg: SetLoadout): Uint8Array {
  const w = new BinaryWriter(10);
  writeLoadout(w, msg);
  return w.finish();
}

export function decodeSetLoadout(bytes: Uint8Array): SetLoadout {
  const r = new BinaryReader(bytes);
  const msg = readLoadout(r);
  if (r.remaining !== 0) throw new RangeError('trailing bytes in SetLoadout');
  return msg;
}

// ---------------------------------------------------------------------------
// Events (kills, hits, damage) — reliable, low rate
// ---------------------------------------------------------------------------

export const HIT_ZONE_CODES = ['head', 'torso', 'limbs'] as const;
export type HitZoneCode = (typeof HIT_ZONE_CODES)[number];

export type GameEvent =
  /** Broadcast: kill feed. */
  /** `weapon`: weapon catalog index, or NO_WEAPON (a fall). */
  | { type: 'kill'; killer: number; victim: number; weapon: number; headshot: boolean }
  /** To the shooter: the server confirmed a hit. */
  | { type: 'hit'; victim: number; damage: number; zone: HitZoneCode; killed: boolean }
  /** To the victim: who hit you, from where, and your health now. */
  | { type: 'damaged'; attacker: number; from: Vec3; health: number }
  /** Broadcast: a frag exploded or a smoke released its cloud (effects and sound). */
  | { type: 'explosion'; kind: 'frag' | 'smoke'; position: Vec3 };

/** Wire value for "no weapon" in kill events and entities. */
export const NO_WEAPON = 255;

const EV_KILL = 1;
const EV_HIT = 2;
const EV_DAMAGED = 3;
const EV_EXPLOSION = 4;

export function encodeEvents(events: GameEvent[]): Uint8Array {
  const w = new BinaryWriter(1 + events.length * 8);
  w.u8(events.length);
  for (const e of events) {
    switch (e.type) {
      case 'kill':
        w.u8(EV_KILL)
          .u8(e.killer)
          .u8(e.victim)
          .u8(e.weapon)
          .u8(e.headshot ? 1 : 0);
        break;
      case 'hit':
        w.u8(EV_HIT)
          .u8(e.victim)
          .u8(Math.min(255, e.damage))
          .u8(HIT_ZONE_CODES.indexOf(e.zone))
          .u8(e.killed ? 1 : 0);
        break;
      case 'damaged':
        w.u8(EV_DAMAGED).u8(e.attacker);
        for (const v of e.from) w.i16(clampI16(quantizePosition(v)));
        w.u8(e.health);
        break;
      case 'explosion':
        w.u8(EV_EXPLOSION).u8(e.kind === 'smoke' ? 1 : 0);
        for (const v of e.position) w.i16(clampI16(quantizePosition(v)));
        break;
    }
  }
  return w.finish();
}

export function decodeEvents(bytes: Uint8Array): GameEvent[] {
  const r = new BinaryReader(bytes);
  const count = r.u8();
  const events: GameEvent[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    if (type === EV_KILL) {
      events.push({
        type: 'kill',
        killer: r.u8(),
        victim: r.u8(),
        weapon: r.u8(),
        headshot: r.u8() === 1,
      });
    } else if (type === EV_HIT) {
      const victim = r.u8();
      const damage = r.u8();
      const zone = HIT_ZONE_CODES[r.u8()] ?? 'torso';
      events.push({ type: 'hit', victim, damage, zone, killed: r.u8() === 1 });
    } else if (type === EV_DAMAGED) {
      const attacker = r.u8();
      const from: Vec3 = [
        dequantizePosition(r.i16()),
        dequantizePosition(r.i16()),
        dequantizePosition(r.i16()),
      ];
      events.push({ type: 'damaged', attacker, from, health: r.u8() });
    } else if (type === EV_EXPLOSION) {
      const kind = r.u8() === 1 ? 'smoke' : 'frag';
      const position: Vec3 = [
        dequantizePosition(r.i16()),
        dequantizePosition(r.i16()),
        dequantizePosition(r.i16()),
      ];
      events.push({ type: 'explosion', kind, position });
    } else {
      throw new RangeError(`unknown event type ${type}`);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// SnapshotAck, Ping / Pong
// ---------------------------------------------------------------------------

export function encodeSnapshotAck(serverTick: number): Uint8Array {
  return new BinaryWriter(4).u32(serverTick).finish();
}

export function decodeSnapshotAck(bytes: Uint8Array): number {
  return new BinaryReader(bytes).u32();
}

/** Ping carries the client's own clock (ms, wrapped to u32); Pong echoes it unchanged. */
export function encodePing(clientTimeMs: number): Uint8Array {
  return new BinaryWriter(4).u32(Math.floor(clientTimeMs) >>> 0).finish();
}

export function decodePing(bytes: Uint8Array): number {
  return new BinaryReader(bytes).u32();
}

// ---------------------------------------------------------------------------
// MatchInfo — match phase, clock, scores and the scoreboard. Reliable, ~2 Hz + on change.
// ---------------------------------------------------------------------------

export const MatchPhase = { Warmup: 0, Countdown: 1, Live: 2, Ended: 3 } as const;
export type MatchPhaseId = (typeof MatchPhase)[keyof typeof MatchPhase];

/** `winner`: a team (0/1), DRAW, or NO_WINNER while the match is running. */
export const DRAW = 2;
export const NO_WINNER = 255;

export interface ScoreboardRow {
  id: number;
  team: number;
  bot: boolean;
  kills: number;
  deaths: number;
  name: string;
}

export interface MatchInfo {
  phase: MatchPhaseId;
  /** Seconds left in the current phase (rounded up). */
  secondsLeft: number;
  scoreLimit: number;
  teamScores: [number, number];
  winner: number;
  /** Player id of the match MVP once ended (0 = none). */
  mvp: number;
  players: ScoreboardRow[];
}

export function encodeMatchInfo(m: MatchInfo): Uint8Array {
  const w = new BinaryWriter(32 + m.players.length * 24);
  w.u8(m.phase)
    .u16(Math.min(0xffff, Math.max(0, Math.ceil(m.secondsLeft))))
    .u16(m.scoreLimit);
  w.u16(m.teamScores[0]).u16(m.teamScores[1]).u8(m.winner).u8(m.mvp).u8(m.players.length);
  for (const p of m.players) {
    w.u8(p.id)
      .u8(p.team)
      .u8(p.bot ? 1 : 0)
      .u16(p.kills)
      .u16(p.deaths)
      .string(p.name);
  }
  return w.finish();
}

export function decodeMatchInfo(bytes: Uint8Array): MatchInfo {
  const r = new BinaryReader(bytes);
  const phase = r.u8();
  if (phase > 3) throw new RangeError(`bad match phase ${phase}`);
  const secondsLeft = r.u16();
  const scoreLimit = r.u16();
  const teamScores: [number, number] = [r.u16(), r.u16()];
  const winner = r.u8();
  const mvp = r.u8();
  const count = r.u8();
  const players: ScoreboardRow[] = [];
  for (let i = 0; i < count; i++) {
    players.push({
      id: r.u8(),
      team: r.u8(),
      bot: r.u8() === 1,
      kills: r.u16(),
      deaths: r.u16(),
      name: r.string(),
    });
  }
  return {
    phase: phase as MatchPhaseId,
    secondsLeft,
    scoreLimit,
    teamScores,
    winner,
    mvp,
    players,
  };
}
