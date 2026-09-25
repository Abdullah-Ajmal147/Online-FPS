/**
 * Phase 1 exit test: "Replay test: client and server final position within 1 cm after 1,000 ticks".
 * 1,000 inputs recorded from a real bot session (tools/bots --record) are fed through the client
 * predictor and the authoritative server simulation, with network delay between them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { maps, movement } from '@sentinel/content';
import {
  Predictor,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  createRng,
  expandMap,
  initPhysics,
  type PlayerInput,
  type PlayerState,
  type Rapier,
  type SequencedInput,
} from '@sentinel/shared';
import recorded from './fixtures/recorded-inputs.json' with { type: 'json' };
import { decodeSnapshot, encodeSnapshot } from '@sentinel/protocol';
import { MatchSim } from './sim.ts';

const INPUTS: PlayerInput[] = (recorded as { inputs: PlayerInput[] }).inputs.slice(0, 1000);
const ONE_WAY_TICKS = 4; // ≈ 66 ms each way → ~130 ms round trip

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

interface Packet<T> {
  at: number;
  payload: T;
}

function run(opts: {
  inputLoss: number;
  snapshotLoss: number;
  seed: number;
  /** Extra players standing on these points in the server's world (the client world has none). */
  obstacles?: [number, number, number][];
}) {
  const random = createRng(opts.seed);
  const server = new MatchSim(rapier, maps.greybox!, movement);
  const player = server.addPlayer();
  const others = (opts.obstacles ?? []).map((pos) => {
    const other = server.addPlayer();
    other.state = { ...other.state, position: pos };
    return other;
  });

  const ctx = createMovementContext(rapier, buildWorld(rapier, expandMap(maps.greybox!)), movement);
  const predictor = new Predictor(player.state, ctx, createPlayerBody(ctx));

  let clientAt1000: PlayerState | null = null;
  let correctionsDuringInputs = 0;
  let serverAt1000: PlayerState | null = null;
  const toServer: Packet<SequencedInput[]>[] = [];
  const toClient: Packet<ReturnType<typeof decodeSnapshot>>[] = [];
  const totalTicks = INPUTS.length + 60; // let the pipeline drain
  for (let t = 0; t < totalTicks; t++) {
    // Client: predict and send the last 3 inputs (redundancy), possibly lost.
    if (t < INPUTS.length) {
      predictor.tick({ ...INPUTS[t]!, weaponSlot: 0 });
      if (t === INPUTS.length - 1) {
        clientAt1000 = predictor.state;
        correctionsDuringInputs = predictor.stats.corrections;
      }
      if (random() >= opts.inputLoss)
        toServer.push({ at: t + ONE_WAY_TICKS, payload: predictor.recentInputs() });
    }
    // Server: receive, simulate one tick, snapshot every 2nd tick.
    while (toServer[0] && toServer[0].at <= t)
      for (const i of toServer.shift()!.payload) player.queue.push(i);
    // Obstacles get idle inputs every tick so the server really simulates them (their
    // capsules are placed in the world where they stand).
    for (const o of others)
      o.queue.push({ seq: t + 1, buttons: 0, yaw: 0, pitch: 0, weaponSlot: 0 });
    server.step();
    if (!serverAt1000 && player.queue.lastProcessedSeq === INPUTS.length)
      serverAt1000 = player.state;
    if (server.tick % 2 === 0 && random() >= opts.snapshotLoss) {
      // Through the real wire format, so encoding bugs show up here too.
      toClient.push({
        at: t + ONE_WAY_TICKS,
        payload: decodeSnapshot(encodeSnapshot(server.snapshotFor(player.id))),
      });
    }
    // Client: reconcile with any snapshot that has arrived.
    while (toClient[0] && toClient[0].at <= t) {
      const snap = toClient.shift()!.payload;
      predictor.onServerState(snap.own!, snap.lastProcessedSeq);
    }
  }
  // Compare where each side was right after the 1,000th input. (After that the server keeps
  // repeating the last input while this test client stops sending, so later states differ.)
  return {
    server: serverAt1000!,
    client: clientAt1000!,
    correctionsDuringInputs,
    obstacleColliders: others.map((o) => {
      const t = o.body.collider.translation();
      return [t.x, t.y, t.z] as [number, number, number];
    }),
    lastSeq: player.queue.lastProcessedSeq,
  };
}

describe('replay: 1,000 recorded inputs through client predictor and server simulation', () => {
  it('uses real recorded inputs', () => {
    expect(INPUTS).toHaveLength(1000);
    expect(new Set(INPUTS.map((i) => i.buttons)).size).toBeGreaterThan(3);
  });

  it('ends at the same position (exactly; the exit test allows 1 cm) with no corrections', () => {
    const r = run({ inputLoss: 0, snapshotLoss: 0, seed: 1 });
    expect(r.lastSeq).toBe(1000);
    expect(r.client.position).toEqual(r.server.position);
    expect(r.correctionsDuringInputs).toBe(0);
  });

  it('matches exactly with 11 other players on the server standing in the path', () => {
    // First run: learn the path, then park other players along it.
    const path = run({ inputLoss: 0, snapshotLoss: 0, seed: 1 });
    expect(path.correctionsDuringInputs).toBe(0);
    const obstacles = Array.from({ length: 11 }, (_, k): [number, number, number] => {
      const f = (k + 1) / 12;
      return [-25 + (path.server.position[0] + 25) * f, 0, 25 + (path.server.position[2] - 25) * f];
    });
    const r = run({ inputLoss: 0, snapshotLoss: 0, seed: 1, obstacles });
    expect(
      r.obstacleColliders.some(
        ([x, , z]) => Math.hypot(x - obstacles[5]![0], z - obstacles[5]![2]) < 0.5,
      ),
    ).toBe(true);
    expect(r.correctionsDuringInputs).toBe(0);
    expect(r.client.position).toEqual(r.server.position);
  });

  it('stays within 1 cm with 10% input loss and 10% snapshot loss', () => {
    const r = run({ inputLoss: 0.1, snapshotLoss: 0.1, seed: 2 });
    const d = Math.hypot(
      r.client.position[0] - r.server.position[0],
      r.client.position[1] - r.server.position[1],
      r.client.position[2] - r.server.position[2],
    );
    expect(d).toBeLessThan(0.01);
    // Travelled somewhere real, not a trivially idle run.
    expect(Math.hypot(r.server.position[0] + 25, r.server.position[2] - 25)).toBeGreaterThan(5);
  });
});
