import {
  INPUT_REDUNDANCY,
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
  /** Server → client once after join. */
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
}

export function encodeHello(msg: Hello): Uint8Array {
  return new BinaryWriter(8)
    .u16(msg.protocolVersion)
    .u8(msg.serverTickRate)
    .u8(msg.playerId)
    .u8(msg.team)
    .finish();
}

export function decodeHello(bytes: Uint8Array): Hello {
  const r = new BinaryReader(bytes);
  return { protocolVersion: r.u16(), serverTickRate: r.u8(), playerId: r.u8(), team: r.u8() };
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
  health: number;
  /** Increments each time we (re)spawn; a change means "reset prediction to this state". */
  lifeId: number;
  /** 0 while alive; otherwise ticks until respawn. */
  respawnTicks: number;
}

export interface EntityState {
  id: number;
  team: number;
  alive: boolean;
  crouching: boolean;
  grounded: boolean;
  /** Metres, quantized to 1/64 m on the wire (int16: maps must stay within ±511 m). */
  position: Vec3;
  yaw: number;
  pitch: number;
  weaponSlot: number;
  /** Wrapping count of shots fired: when it changes, draw muzzle flashes/tracers. */
  shotCount: number;
}

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
}

const OWN_GROUNDED = 1;
const OWN_CROUCHING = 2;
const ENT_GROUNDED = 1;
const ENT_CROUCHING = 2;
const ENT_ALIVE = 4;

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
  w.u8(own.health)
    .u8(own.lifeId & 0xff)
    .u8(own.respawnTicks);
}

function readOwn(r: BinaryReader): OwnSnapshot {
  const position: Vec3 = [r.f32(), r.f32(), r.f32()];
  const velocity: Vec3 = [r.f32(), r.f32(), r.f32()];
  const slideTicks = r.u8();
  const slideCooldownTicks = r.u8();
  const flags = r.u8();
  const prevButtons = r.u16();
  const weapon = readWeapon(r);
  return {
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
  };
}

const clampI16 = (v: number) => Math.max(-0x8000, Math.min(0x7fff, v));

/**
 * Layout: serverTick u32, lastProcessedSeq u32, inputQueueDepth u8, serverTickMicros u16,
 * hasOwn u8, [own: move 29 + weapon 18 + health/lifeId/respawn 3 = 50 bytes], entityCount u8,
 * entities × 15 bytes (id, team, flags, x/y/z i16 at 1/64 m, yaw u16, pitch i16, slot, shots).
 * Full snapshots, no delta compression (ADR 0004); 12 players stay under 10 KB/s.
 */
export function encodeSnapshot(msg: Snapshot): Uint8Array {
  const w = new BinaryWriter(96 + msg.entities.length * 15);
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
      .u8(e.weaponSlot)
      .u8(e.shotCount & 0xff);
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
      weaponSlot: r.u8(),
      shotCount: r.u8(),
    });
  }
  return { serverTick, lastProcessedSeq, inputQueueDepth, serverTickMicros, own, entities };
}

// ---------------------------------------------------------------------------
// Events (kills, hits, damage) — reliable, low rate
// ---------------------------------------------------------------------------

export const HIT_ZONE_CODES = ['head', 'torso', 'limbs'] as const;
export type HitZoneCode = (typeof HIT_ZONE_CODES)[number];

export type GameEvent =
  /** Broadcast: kill feed. */
  | { type: 'kill'; killer: number; victim: number; weaponSlot: number; headshot: boolean }
  /** To the shooter: the server confirmed a hit. */
  | { type: 'hit'; victim: number; damage: number; zone: HitZoneCode; killed: boolean }
  /** To the victim: who hit you, from where, and your health now. */
  | { type: 'damaged'; attacker: number; from: Vec3; health: number };

const EV_KILL = 1;
const EV_HIT = 2;
const EV_DAMAGED = 3;

export function encodeEvents(events: GameEvent[]): Uint8Array {
  const w = new BinaryWriter(1 + events.length * 8);
  w.u8(events.length);
  for (const e of events) {
    switch (e.type) {
      case 'kill':
        w.u8(EV_KILL)
          .u8(e.killer)
          .u8(e.victim)
          .u8(e.weaponSlot)
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
        weaponSlot: r.u8(),
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
