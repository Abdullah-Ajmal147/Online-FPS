import { describe, expect, it } from 'vitest';
import { SNAPSHOT_RATE, MAX_PLAYERS_PER_MATCH, type Vec3 } from '@sentinel/shared';
import {
  decodeHello,
  decodeInputCmd,
  decodePing,
  decodeSnapshot,
  decodeSnapshotAck,
  encodeHello,
  encodeInputCmd,
  encodePing,
  encodeSnapshot,
  encodeSnapshotAck,
  type EntityState,
  type OwnState,
  type Snapshot,
} from './messages.ts';
import { PROTOCOL_VERSION } from './version.ts';

const own: OwnState = {
  position: [Math.fround(-12.345678), Math.fround(1.0625), Math.fround(7.000001)],
  velocity: [Math.fround(7.5), Math.fround(-3.3333), 0],
  grounded: false,
  crouching: true,
  slideTicks: 17,
  slideCooldownTicks: 36,
  prevButtons: 0b10_0110_0001,
};

const entity = (id: number, position: Vec3): EntityState => ({
  id,
  team: id % 2,
  grounded: true,
  crouching: id % 3 === 0,
  position,
  yaw: (id * 5000) & 0xffff,
  pitch: -1200 + id,
});

describe('protocol version', () => {
  it('is 2 (Phase 1 messages)', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe('Hello', () => {
  it('round-trips', () => {
    const msg = { protocolVersion: PROTOCOL_VERSION, serverTickRate: 60, playerId: 7 };
    expect(decodeHello(encodeHello(msg))).toEqual(msg);
  });
});

describe('InputCmd', () => {
  const inputs = [
    { seq: 1000, buttons: 0x41, yaw: 65535, pitch: -16000, weaponSlot: 0 },
    { seq: 1001, buttons: 0x51, yaw: 12, pitch: 16000, weaponSlot: 1 },
    { seq: 1002, buttons: 0, yaw: 0, pitch: 0, weaponSlot: 2 },
  ];

  it('round-trips 1 to 3 inputs', () => {
    for (let n = 1; n <= 3; n++) {
      const msg = { ackServerTick: 4_000_000_000, inputs: inputs.slice(0, n) };
      expect(decodeInputCmd(encodeInputCmd(msg))).toEqual(msg);
    }
  });

  it('is 30 bytes with 3 inputs (4 ack + 1 count + 4 seq + 3 × 7)', () => {
    expect(encodeInputCmd({ ackServerTick: 1, inputs }).length).toBe(30);
  });

  it('rejects malformed client bytes', () => {
    const good = encodeInputCmd({ ackServerTick: 1, inputs });
    expect(() => decodeInputCmd(good.subarray(0, good.length - 1))).toThrow(RangeError);
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(() => decodeInputCmd(extra)).toThrow(RangeError);
    const badCount = good.slice();
    badCount[4] = 200;
    expect(() => decodeInputCmd(badCount)).toThrow(RangeError);
    const zero = good.slice();
    zero[4] = 0;
    expect(() => decodeInputCmd(zero)).toThrow(RangeError);
  });

  it('refuses to encode non-consecutive seqs', () => {
    expect(() =>
      encodeInputCmd({ ackServerTick: 1, inputs: [inputs[0]!, { ...inputs[2]! }] }),
    ).toThrow(RangeError);
  });
});

describe('Snapshot', () => {
  const snap: Snapshot = {
    serverTick: 123456,
    lastProcessedSeq: 999,
    inputQueueDepth: 2,
    serverTickMicros: 850,
    own,
    entities: [entity(1, [1.5, 0, -3.25]), entity(2, [-29.984375, 3, 29.5])],
  };

  it('round-trips the own-player block exactly (ADR 0003)', () => {
    expect(decodeSnapshot(encodeSnapshot(snap)).own).toEqual(own);
  });

  it('round-trips everything else, positions within 1/128 m', () => {
    const back = decodeSnapshot(
      encodeSnapshot({ ...snap, entities: [entity(4, [0.123, 1.777, -9.99])] }),
    );
    expect(back.serverTick).toBe(123456);
    expect(back.lastProcessedSeq).toBe(999);
    expect(back.inputQueueDepth).toBe(2);
    expect(back.serverTickMicros).toBe(850);
    const e = back.entities[0]!;
    expect(e).toMatchObject({
      id: 4,
      team: 0,
      grounded: true,
      crouching: false,
      yaw: 20000,
      pitch: -1196,
    });
    [0.123, 1.777, -9.99].forEach((v, i) =>
      expect(Math.abs(e.position[i]! - v)).toBeLessThanOrEqual(1 / 128),
    );
  });

  it('works without an own block (spectator / not spawned)', () => {
    expect(decodeSnapshot(encodeSnapshot({ ...snap, own: null })).own).toBeNull();
  });

  it('fits the 10 KB/s per-player budget with a full 12-player match', () => {
    const others = Array.from({ length: MAX_PLAYERS_PER_MATCH - 1 }, (_, i) =>
      entity(i + 1, [i * 3.1, 0.5, -i * 2.7]),
    );
    const bytes = encodeSnapshot({ ...snap, entities: others }).length;
    const overhead = 8; // WebSocket frame + Colyseus message header, generous
    const bytesPerSecond = (bytes + overhead) * SNAPSHOT_RATE;
    expect(bytesPerSecond).toBeLessThan(10 * 1024);
  });
});

describe('SnapshotAck and Ping', () => {
  it('round-trip', () => {
    expect(decodeSnapshotAck(encodeSnapshotAck(77))).toBe(77);
    expect(decodePing(encodePing(123456.9))).toBe(123456);
    expect(decodePing(encodePing(2 ** 32 + 5))).toBe(5); // wraps
  });
});
