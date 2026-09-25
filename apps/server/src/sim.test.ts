import { beforeAll, describe, expect, it } from 'vitest';
import { maps, movement } from '@sentinel/content';
import { Button, MAX_PLAYERS_PER_MATCH, initPhysics, type Rapier } from '@sentinel/shared';
import { MatchSim } from './sim.ts';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

const newSim = () => new MatchSim(rapier, maps.greybox!, movement);

describe('MatchSim', () => {
  it('assigns unique ids and balances teams', () => {
    const sim = newSim();
    const players = Array.from({ length: 4 }, () => sim.addPlayer());
    expect(new Set(players.map((p) => p.id)).size).toBe(4);
    expect(players.map((p) => p.team)).toEqual([0, 1, 0, 1]);
  });

  it('refuses a 13th player', () => {
    const sim = newSim();
    for (let i = 0; i < MAX_PLAYERS_PER_MATCH; i++) sim.addPlayer();
    expect(() => sim.addPlayer()).toThrow();
  });

  it('moves players only by their inputs, one step per tick', () => {
    const sim = newSim();
    const p = sim.addPlayer();
    const z0 = p.state.position[2];
    for (let seq = 1; seq <= 30; seq++) {
      p.queue.push({ seq, buttons: Button.Forward, yaw: p.state.yaw, pitch: 0, weaponSlot: 0 });
      sim.step();
    }
    // Start buffer of 2: one tick waits, then one input per tick.
    expect(p.queue.lastProcessedSeq).toBe(29);
    expect(z0 - p.state.position[2]).toBeGreaterThan(1); // team 0 spawns facing -Z
    expect(z0 - p.state.position[2]).toBeLessThan(5 * 0.5 + 0.01); // at most 30 ticks at walk speed
  });

  it('builds per-player snapshots: own block for me, everyone else as entities', () => {
    const sim = newSim();
    const a = sim.addPlayer();
    const b = sim.addPlayer();
    sim.step();
    const snap = sim.snapshotFor(a.id);
    expect(snap.serverTick).toBe(1);
    expect(snap.own?.position).toEqual(a.state.position);
    expect(snap.entities.map((e) => e.id)).toEqual([b.id]);
  });

  it('a flooding client gets no extra steps: queue is capped, one step per tick', () => {
    const sim = newSim();
    const p = sim.addPlayer();
    const z0 = p.state.position[2];
    for (let seq = 1; seq <= 600; seq++) {
      p.queue.push({
        seq,
        buttons: Button.Forward | Button.Sprint,
        yaw: p.state.yaw,
        pitch: 0,
        weaponSlot: 0,
      });
    }
    for (let i = 0; i < 60; i++) sim.step(); // one second
    expect(z0 - p.state.position[2]).toBeLessThanOrEqual(7.5 + 0.01);
  });

  it('frees the id and collider when a player leaves', () => {
    const sim = newSim();
    const a = sim.addPlayer();
    sim.addPlayer();
    sim.removePlayer(a.id);
    expect(sim.addPlayer().id).toBe(a.id);
  });

  it('ticks a full 12-player match well under the 4 ms budget', () => {
    const sim = newSim();
    const players = Array.from({ length: MAX_PLAYERS_PER_MATCH }, () => sim.addPlayer());
    let seq = 0;
    let worst = 0;
    let total = 0;
    for (let t = 0; t < 600; t++) {
      seq++;
      for (const p of players) {
        const buttons =
          (t % 120 < 80 ? Button.Forward | Button.Sprint : Button.Left) |
          (t % 90 === 0 ? Button.Jump : 0);
        p.queue.push({
          seq,
          buttons,
          yaw: (t * 50 + p.id * 3000) & 0xffff,
          pitch: 0,
          weaponSlot: 0,
        });
      }
      sim.step();
      if (t > 60) {
        worst = Math.max(worst, sim.lastTickMicros);
        total += sim.lastTickMicros;
      }
    }
    const avgMs = total / 539 / 1000;
    expect(avgMs).toBeLessThan(4);
    // Log for the PROGRESS notes; the budget check is on the average (CI machines vary).
    console.info(
      `[perf] 12 players: avg ${avgMs.toFixed(3)} ms, worst ${(worst / 1000).toFixed(3)} ms`,
    );
  });
});
