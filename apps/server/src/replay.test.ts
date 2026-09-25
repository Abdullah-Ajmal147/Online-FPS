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

function run(opts: { inputLoss: number; snapshotLoss: number; seed: number }) {
  const random = createRng(opts.seed);
  const server = new MatchSim(rapier, maps.greybox!, movement);
  const player = server.addPlayer();

  const ctx = createMovementContext(rapier, buildWorld(rapier, expandMap(maps.greybox!)), movement);
  const predictor = new Predictor(player.state, ctx, createPlayerBody(ctx));

  let clientAt1000: PlayerState | null = null;
  let correctionsDuringInputs = 0;
  let serverAt1000: PlayerState | null = null;
  const toServer: Packet<SequencedInput[]>[] = [];
  const toClient: Packet<ReturnType<MatchSim['snapshotFor']>>[] = [];
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
    server.step();
    if (!serverAt1000 && player.queue.lastProcessedSeq === INPUTS.length)
      serverAt1000 = player.state;
    if (server.tick % 2 === 0 && random() >= opts.snapshotLoss) {
      toClient.push({ at: t + ONE_WAY_TICKS, payload: server.snapshotFor(player.id) });
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
