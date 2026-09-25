import { INPUT_REDUNDANCY, type PlayerInput, type PlayerState, type Vec3 } from '@sentinel/shared';
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
} as const;

// ---------------------------------------------------------------------------
// Hello
// ---------------------------------------------------------------------------

export interface Hello {
  protocolVersion: number;
  serverTickRate: number;
  /** Entity id of the receiving player (appears in other clients' snapshots). */
  playerId: number;
}

export function encodeHello(msg: Hello): Uint8Array {
  return new BinaryWriter(8)
    .u16(msg.protocolVersion)
    .u8(msg.serverTickRate)
    .u8(msg.playerId)
    .finish();
}

export function decodeHello(bytes: Uint8Array): Hello {
  const r = new BinaryReader(bytes);
  return { protocolVersion: r.u16(), serverTickRate: r.u8(), playerId: r.u8() };
}

// ---------------------------------------------------------------------------
// InputCmd
// ---------------------------------------------------------------------------

export interface SequencedInput extends PlayerInput {
  seq: number;
  weaponSlot: number;
}

export interface InputCmd {
  /** Newest serverTick the client has received (the snapshot ack). */
  ackServerTick: number;
  /** Consecutive inputs, oldest first; the last one is new, the others are resent in case of loss. */
  inputs: SequencedInput[];
}

/**
 * Layout: ackServerTick u32, count u8, firstSeq u32,
 * then per input: buttons u16, yaw u16, pitch i16, weaponSlot u8. Seqs are consecutive.
 */
export function encodeInputCmd(msg: InputCmd): Uint8Array {
  const { inputs } = msg;
  if (inputs.length < 1 || inputs.length > INPUT_REDUNDANCY) {
    throw new RangeError(`InputCmd carries 1..${INPUT_REDUNDANCY} inputs, got ${inputs.length}`);
  }
  const w = new BinaryWriter(10 + inputs.length * 7);
  w.u32(msg.ackServerTick).u8(inputs.length).u32(inputs[0]!.seq);
  inputs.forEach((input, i) => {
    if (input.seq !== inputs[0]!.seq + i) throw new RangeError('InputCmd seqs must be consecutive');
    w.u16(input.buttons).u16(input.yaw).i16(input.pitch).u8(input.weaponSlot);
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
    inputs.push({
      seq: firstSeq + i,
      buttons: r.u16(),
      yaw: r.u16(),
      pitch: r.i16(),
      weaponSlot: r.u8(),
    });
  }
  if (r.remaining !== 0) throw new RangeError('trailing bytes in InputCmd');
  return { ackServerTick, inputs };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Everything step() reads, sent losslessly to the owning player (ADR 0003 table). */
export type OwnState = Omit<PlayerState, 'yaw' | 'pitch'>;

export interface EntityState {
  id: number;
  team: number;
  crouching: boolean;
  grounded: boolean;
  /** Metres, quantized to 1/64 m on the wire. */
  position: Vec3;
  yaw: number;
  pitch: number;
}

export interface Snapshot {
  serverTick: number;
  /** Last input seq the server applied for the receiving player (0 = none yet). */
  lastProcessedSeq: number;
  /** Inputs waiting in the server's queue for this player; the client paces itself on it. */
  inputQueueDepth: number;
  /** Server simulation time of the last tick, microseconds (debug overlay). */
  serverTickMicros: number;
  own: OwnState | null;
  entities: EntityState[];
}

const OWN_GROUNDED = 1;
const OWN_CROUCHING = 2;
const ENT_GROUNDED = 1;
const ENT_CROUCHING = 2;

function writeOwn(w: BinaryWriter, s: OwnState): void {
  for (const v of s.position) w.f32(v);
  for (const v of s.velocity) w.f32(v);
  w.u8(s.slideTicks).u8(s.slideCooldownTicks);
  w.u8((s.grounded ? OWN_GROUNDED : 0) | (s.crouching ? OWN_CROUCHING : 0));
  w.u16(s.prevButtons);
}

function readOwn(r: BinaryReader): OwnState {
  const position: Vec3 = [r.f32(), r.f32(), r.f32()];
  const velocity: Vec3 = [r.f32(), r.f32(), r.f32()];
  const slideTicks = r.u8();
  const slideCooldownTicks = r.u8();
  const flags = r.u8();
  return {
    position,
    velocity,
    slideTicks,
    slideCooldownTicks,
    grounded: (flags & OWN_GROUNDED) !== 0,
    crouching: (flags & OWN_CROUCHING) !== 0,
    prevButtons: r.u16(),
  };
}

/**
 * Layout: serverTick u32, lastProcessedSeq u32, inputQueueDepth u8, serverTickMicros u16,
 * hasOwn u8, [own 29 bytes], entityCount u8, entities × (id u8, team u8, flags u8,
 * x/y/z i32 at 1/64 m, yaw u16, pitch i16).
 * Full snapshots, no delta compression: 12 players fit the 10 KB/s budget (see size test).
 */
export function encodeSnapshot(msg: Snapshot): Uint8Array {
  const w = new BinaryWriter(64 + msg.entities.length * 19);
  w.u32(msg.serverTick).u32(msg.lastProcessedSeq).u8(Math.min(255, msg.inputQueueDepth));
  w.u16(Math.min(0xffff, Math.round(msg.serverTickMicros)));
  w.u8(msg.own ? 1 : 0);
  if (msg.own) writeOwn(w, msg.own);
  w.u8(msg.entities.length);
  for (const e of msg.entities) {
    w.u8(e.id)
      .u8(e.team)
      .u8((e.grounded ? ENT_GROUNDED : 0) | (e.crouching ? ENT_CROUCHING : 0));
    for (const v of e.position) w.i32(quantizePosition(v));
    w.u16(e.yaw).i16(e.pitch);
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
      dequantizePosition(r.i32()),
      dequantizePosition(r.i32()),
      dequantizePosition(r.i32()),
    ];
    entities.push({
      id,
      team,
      grounded: (flags & ENT_GROUNDED) !== 0,
      crouching: (flags & ENT_CROUCHING) !== 0,
      position,
      yaw: r.u16(),
      pitch: r.i16(),
    });
  }
  return { serverTick, lastProcessedSeq, inputQueueDepth, serverTickMicros, own, entities };
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
