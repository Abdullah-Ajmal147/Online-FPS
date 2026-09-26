import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS_PER_MATCH, SNAPSHOT_RATE, type Vec3 } from '@sentinel/shared';
import {
  NO_WEAPON,
  decodeChat,
  decodeChatSend,
  encodeChat,
  encodeChatSend,
  decodeSetLoadout,
  encodeSetLoadout,
  decodeEvents,
  decodeHello,
  decodeMatchInfo,
  decodeInputCmd,
  decodePing,
  decodeSnapshot,
  decodeSnapshotAck,
  encodeEvents,
  encodeHello,
  encodeMatchInfo,
  encodeInputCmd,
  encodePing,
  encodeSnapshot,
  encodeSnapshotAck,
  type EntityState,
  type GameEvent,
  type OwnSnapshot,
  type Snapshot,
} from './messages.ts';
import { PROTOCOL_VERSION } from './version.ts';

const own: OwnSnapshot = {
  sim: {
    move: {
      position: [Math.fround(-12.345678), Math.fround(1.0625), Math.fround(7.000001)],
      velocity: [Math.fround(7.5), Math.fround(-3.3333), 0],
      grounded: false,
      crouching: true,
      slideTicks: 17,
      slideCooldownTicks: 36,
      prevButtons: 0b10_0110_0001,
    },
    weapon: {
      slot: 1,
      ammo: [
        { ammo: 17, reserve: 120 },
        { ammo: 3, reserve: 40000 },
      ],
      cooldownTicks: 5,
      reloadTicks: 90,
      switchTicks: 0,
      adsTicks: 12,
      shotIndex: 7,
      recoilPitch: 1500,
      recoilYaw: -320,
      bloom: 400,
    },
  },
  loadout: { primary: 3, secondary: 4, attachments: [0, 5, 9], perks: [2] },
  health: 64,
  lifeId: 3,
  respawnTicks: 0,
  frags: 1,
  smokes: 0,
};

const entity = (id: number, position: Vec3): EntityState => ({
  id,
  team: id % 2,
  alive: id !== 3,
  grounded: true,
  crouching: id % 3 === 0,
  position,
  yaw: (id * 5000) & 0xffff,
  pitch: -1200 + id,
  weapon: id % 5,
  shotCount: (id * 37) & 0xff,
});

describe('protocol version', () => {
  it('is 13 (private matches: MatchInfo.private, SwitchTeam)', () => {
    expect(PROTOCOL_VERSION).toBe(13);
  });
});

describe('Hello', () => {
  it('round-trips', () => {
    const msg = {
      protocolVersion: PROTOCOL_VERSION,
      serverTickRate: 60,
      playerId: 7,
      team: 1,
      mapId: 'greybox',
      inviteToken: 'Zq3-_x9AbC0k',
    };
    expect(decodeHello(encodeHello(msg))).toEqual(msg);
  });
});

describe('InputCmd', () => {
  const inputs = [
    { seq: 1000, buttons: 0x41, yaw: 65535, pitch: -16000, weaponSlot: 0, viewTick: 5000.5 },
    { seq: 1001, buttons: 0x51, yaw: 12, pitch: 16000, weaponSlot: 1, viewTick: 5001.25 },
    { seq: 1002, buttons: 0, yaw: 0, pitch: 0, weaponSlot: 1, viewTick: 5002 },
  ];

  it('round-trips 1 to 3 inputs, view tick to 1/256 of a tick', () => {
    for (let n = 1; n <= 3; n++) {
      const msg = { ackServerTick: 4_000_000_000, inputs: inputs.slice(0, n) };
      expect(decodeInputCmd(encodeInputCmd(msg))).toEqual(msg);
    }
  });

  it('is 45 bytes with 3 inputs (4 ack + 1 count + 4 seq + 3 × 12)', () => {
    expect(encodeInputCmd({ ackServerTick: 1, inputs }).length).toBe(45);
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

  it('rejects seqs that would overflow u32 (a crafted packet once crashed the server)', () => {
    const packet = encodeInputCmd({ ackServerTick: 1, inputs });
    new DataView(packet.buffer).setUint32(5, 0xfffffffe, true); // firstSeq; 3 inputs → overflow
    expect(() => decodeInputCmd(packet)).toThrow(RangeError);
    new DataView(packet.buffer).setUint32(5, 0xfffffffd, true); // last seq exactly 0xffffffff: ok
    expect(() => decodeInputCmd(packet)).not.toThrow();
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
    entities: [entity(1, [1.5, 0, -3.25]), entity(3, [-29.984375, 3, 29.5])],
    projectiles: [
      { id: 7, kind: 'frag', cloud: false, position: [1.25, 2.5, -3] },
      { id: 200, kind: 'smoke', cloud: true, position: [-10, 0.0625, 4] },
    ],
  };

  it('round-trips grenades and smoke clouds', () => {
    expect(decodeSnapshot(encodeSnapshot(snap)).projectiles).toEqual(snap.projectiles);
  });

  it('round-trips the own block exactly: movement, weapon, health (ADR 0003)', () => {
    expect(decodeSnapshot(encodeSnapshot(snap)).own).toEqual(own);
  });

  it('round-trips entities, positions within 1/128 m', () => {
    const back = decodeSnapshot(
      encodeSnapshot({ ...snap, entities: [entity(3, [0.123, 1.777, -9.99])] }),
    );
    const e = back.entities[0]!;
    expect(e).toMatchObject({
      id: 3,
      team: 1,
      alive: false,
      crouching: true,
      weapon: 3,
      shotCount: 111,
    });
    [0.123, 1.777, -9.99].forEach((v, i) =>
      expect(Math.abs(e.position[i]! - v)).toBeLessThanOrEqual(1 / 128),
    );
  });

  it('works without an own block', () => {
    expect(decodeSnapshot(encodeSnapshot({ ...snap, own: null })).own).toBeNull();
  });

  it('fits the 10 KB/s per-player budget with a full 12-player match', () => {
    const others = Array.from({ length: MAX_PLAYERS_PER_MATCH - 1 }, (_, i) =>
      entity(i + 1, [i * 3.1, 0.5, -i * 2.7]),
    );
    const bytes = encodeSnapshot({ ...snap, entities: others }).length;
    const overhead = 8; // WebSocket frame + Colyseus message header, generous
    expect((bytes + overhead) * SNAPSHOT_RATE).toBeLessThan(10 * 1024);
  });
});

describe('Events', () => {
  it('round-trips kills, hits and damage', () => {
    const events: GameEvent[] = [
      { type: 'kill', killer: 2, victim: 5, weapon: 0, headshot: true },
      { type: 'kill', killer: 5, victim: 5, weapon: NO_WEAPON, headshot: false },
      { type: 'hit', victim: 5, damage: 34, zone: 'head', killed: true },
      { type: 'damaged', attacker: 2, from: [10.5, 1.5, -3], health: 66 },
      { type: 'explosion', kind: 'frag', position: [4, 0.5, -2.25] },
      { type: 'explosion', kind: 'smoke', position: [-4, 0, 2] },
    ];
    expect(decodeEvents(encodeEvents(events))).toEqual(events);
  });

  it('rejects unknown event types', () => {
    expect(() => decodeEvents(new Uint8Array([1, 99]))).toThrow(RangeError);
  });
});

describe('SetLoadout', () => {
  it('round-trips weapon indices', () => {
    const msg = { primary: 3, secondary: 4, attachments: [1, 7], perks: [0, 2, 4] };
    expect(decodeSetLoadout(encodeSetLoadout(msg))).toEqual(msg);
    const empty = { primary: 0, secondary: 1, attachments: [], perks: [] };
    expect(decodeSetLoadout(encodeSetLoadout(empty))).toEqual(empty);
  });

  it('rejects trailing bytes', () => {
    expect(() => decodeSetLoadout(new Uint8Array([1, 2, 0, 0, 9]))).toThrow(RangeError);
  });

  it('rejects over-long attachment or perk lists', () => {
    expect(() => decodeSetLoadout(new Uint8Array([1, 2, 4, 0, 1, 2, 3, 0]))).toThrow(RangeError);
    expect(() =>
      encodeSetLoadout({ primary: 0, secondary: 1, attachments: [], perks: [0, 1, 2, 3] }),
    ).toThrow(RangeError);
  });
});

describe('Chat', () => {
  it('round-trips send and broadcast, including non-ASCII text', () => {
    const send = { team: true, text: 'gg — nice shot 👍' };
    expect(decodeChatSend(encodeChatSend(send))).toEqual(send);
    const line = { from: 7, team: false, text: 'مرحبا' };
    expect(decodeChat(encodeChat(line))).toEqual(line);
  });

  it('rejects trailing bytes in ChatSend', () => {
    const bytes = encodeChatSend({ team: false, text: 'hi' });
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => decodeChatSend(longer)).toThrow(RangeError);
  });
});

describe('SnapshotAck and Ping', () => {
  it('round-trip', () => {
    expect(decodeSnapshotAck(encodeSnapshotAck(77))).toBe(77);
    expect(decodePing(encodePing(123456.9))).toBe(123456);
    expect(decodePing(encodePing(2 ** 32 + 5))).toBe(5); // wraps
  });
});

describe('MatchInfo', () => {
  it('round-trips phase, clock, scores and the scoreboard (names included)', () => {
    const info = {
      phase: 2 as const,
      secondsLeft: 431,
      scoreLimit: 75,
      teamScores: [41, 38] as [number, number],
      winner: 255,
      mvp: 0,
      mode: 'domination',
      private: true,
      points: [
        { id: 'A', owner: 0, control: 1 },
        { id: 'B', owner: -1, control: -0.37 },
        { id: 'C', owner: 1, control: -1 },
      ],
      players: [
        { id: 1, team: 0, bot: false, kills: 12, deaths: 4, name: 'Ayesha', code: 'a1b2c3d4e5' },
        { id: 2, team: 1, bot: true, kills: 9, deaths: 7, name: 'Bot Heron', code: '' },
      ],
    };
    expect(decodeMatchInfo(encodeMatchInfo(info))).toEqual(info);
  });

  it('rounds seconds up and rejects bad phases', () => {
    const info = {
      phase: 0 as const,
      secondsLeft: 4.2,
      scoreLimit: 75,
      teamScores: [0, 0] as [number, number],
      winner: 255,
      mvp: 0,
      mode: 'team-deathmatch',
      private: false,
      points: [],
      players: [],
    };
    expect(decodeMatchInfo(encodeMatchInfo(info)).secondsLeft).toBe(5);
    expect(() => decodeMatchInfo(new Uint8Array([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      RangeError,
    );
  });
});
