import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLoadout, maps, movement, type GameMap } from '@sentinel/content';
import {
  Button,
  MAX_PLAYERS_PER_MATCH,
  createPlayerState,
  initPhysics,
  type Rapier,
  type Vec3,
} from '@sentinel/shared';
import {
  MAX_HEALTH,
  MAX_REWIND_TICKS,
  MatchSim,
  REGEN_DELAY_TICKS,
  RESPAWN_TICKS,
  type SimPlayer,
} from './sim.ts';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

/** Open 60×60 floor, no cover, one spawn per team far apart. */
const arena: GameMap = {
  id: 'arena',
  name: 'Arena',
  killY: -20,
  geometry: [
    { kind: 'box', center: [0, -0.5, 0], size: [60, 1, 60], yawDeg: 0, material: 'floor' },
    { kind: 'box', center: [0, 2, -20], size: [4, 4, 1], yawDeg: 0, material: 'wall' }, // cover at z=-20
  ],
  spawns: [
    { team: 0, position: [0, 0, 20], yawDeg: 0 },
    { team: 1, position: [0, 0, -25], yawDeg: 180 },
  ],
};

const newSim = (map: GameMap = maps.greybox!) =>
  new MatchSim(rapier, map, movement, defaultLoadout, 42);

/** Put a player at a spot, standing still, facing -Z. */
function place(p: SimPlayer, pos: Vec3): void {
  p.sim = { ...p.sim, move: { ...createPlayerState(pos, 0), grounded: true } };
  p.protectedUntil = 0; // tests place players directly: no spawn protection
}

/**
 * Feed one input per tick, returning resolved shots. The first call also fills the server's
 * 2-input start buffer; after that the server always holds one input, so each input is
 * simulated one tick after it is fed.
 */
function feed(
  sim: MatchSim,
  p: SimPlayer,
  ticks: number,
  buttons: number,
  extra: { yaw?: number; pitch?: number } = {},
) {
  const shots = [];
  const push = () => {
    const seq = p.queue.lastProcessedSeq + p.queue.depth + 1;
    p.queue.push({
      seq,
      buttons,
      yaw: extra.yaw ?? 0,
      pitch: extra.pitch ?? 0,
      weaponSlot: 0,
      viewTick: sim.tick,
    });
  };
  if (p.queue.lastProcessedSeq === 0 && p.queue.depth === 0) push();
  for (let i = 0; i < ticks; i++) {
    push();
    sim.step();
    shots.push(...sim.lastShots);
  }
  return shots;
}

/** Aim down sights long enough to reach full ADS (tight spread). */
function aimIn(sim: MatchSim, p: SimPlayer, pitch: number) {
  feed(sim, p, 20, Button.Aim, { pitch });
}
const AIM_FIRE = Button.Aim | Button.Fire;

/** Pitch (16-bit) that aims from shooter's eye at a height on a target d metres away. */
function aimPitch(eyeY: number, targetY: number, d: number): number {
  return Math.round((Math.atan2(targetY - eyeY, d) / (Math.PI / 2)) * 16384);
}

describe('MatchSim: players', () => {
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
    const z0 = p.sim.move.position[2];
    feed(sim, p, 30, Button.Forward, { yaw: p.sim.move.yaw });
    expect(p.queue.lastProcessedSeq).toBeLessThanOrEqual(30);
    expect(z0 - p.sim.move.position[2]).toBeGreaterThan(1);
  });

  it('a flooding client gets no extra steps', () => {
    const sim = newSim();
    const p = sim.addPlayer();
    const z0 = p.sim.move.position[2];
    for (let seq = 1; seq <= 600; seq++) {
      p.queue.push({
        seq,
        buttons: Button.Forward | Button.Sprint,
        yaw: p.sim.move.yaw,
        pitch: 0,
        weaponSlot: 0,
        viewTick: 0,
      });
    }
    for (let i = 0; i < 60; i++) sim.step();
    expect(z0 - p.sim.move.position[2]).toBeLessThanOrEqual(7.5 + 0.01);
  });

  it('builds per-player snapshots with own weapon and health', () => {
    const sim = newSim();
    const a = sim.addPlayer();
    const b = sim.addPlayer();
    sim.step();
    const snap = sim.snapshotFor(a.id);
    expect(snap.own?.health).toBe(MAX_HEALTH);
    expect(snap.own?.sim.weapon.ammo[0].ammo).toBe(defaultLoadout[0].magazine);
    expect(snap.entities.map((e) => e.id)).toEqual([b.id]);
  });
});

describe('MatchSim: shooting', () => {
  function duel() {
    const sim = newSim(arena);
    const shooter = sim.addPlayer(); // team 0
    const target = sim.addPlayer(); // team 1
    place(shooter, [0, 0, 10]);
    place(target, [0, 0, 0]);
    return { sim, shooter, target };
  }

  it('hits the torso, applies rifle damage and confirms to shooter and victim', () => {
    const { sim, shooter, target } = duel();
    const pitch = aimPitch(1.67, 1.1, 10);
    aimIn(sim, shooter, pitch);
    // The server keeps one input buffered, so the fire input is simulated on the 2nd tick.
    const shots = feed(sim, shooter, 2, AIM_FIRE, { pitch });
    const hit = shots.find((s) => s.hit)?.hit;
    expect(hit).toMatchObject({
      victim: target.id,
      zone: 'torso',
      damage: defaultLoadout[0].damage.torso,
    });
    expect(target.health).toBe(MAX_HEALTH - defaultLoadout[0].damage.torso);
  });

  it('kills in 5 body shots, fires a kill event, and respawns the victim after 3 s', () => {
    const { sim, shooter, target } = duel();
    const pitch = aimPitch(1.67, 1.1, 10);
    aimIn(sim, shooter, pitch);
    const events: string[] = [];
    for (let i = 0; i < 60 && target.alive; i++) {
      feed(sim, shooter, 1, AIM_FIRE, { pitch });
      events.push(...sim.events.map((e) => e.event.type));
    }
    expect(target.alive).toBe(false);
    expect(events).toContain('kill');
    expect(shooter.kills).toBe(1);
    expect(target.deaths).toBe(1);
    const life = target.lifeId;
    for (let i = 0; i < RESPAWN_TICKS; i++) sim.step();
    expect(target.alive).toBe(true);
    expect(target.health).toBe(MAX_HEALTH);
    expect(target.lifeId).toBe(life + 1);
  });

  it('a 2× fire-rate client gets 0 extra hits (Phase 2 exit test)', () => {
    // Fire pressed every tick vs the legit held trigger: the server-side weapon gates both
    // to 600 rpm, so over 1 s both get exactly 10 shots.
    const legit = duel();
    const pitch = aimPitch(1.67, 1.1, 10);
    const legitShots = feed(legit.sim, legit.shooter, 60, Button.Fire, { pitch }).length;
    const cheat = duel();
    let cheatShots = 0;
    for (let i = 0; i < 60; i++) {
      // Toggle fire every tick (tries to beat the cooldown with presses) — and send 2 inputs per tick.
      for (let k = 0; k < 2; k++) {
        const seq = cheat.shooter.queue.lastProcessedSeq + cheat.shooter.queue.depth + 1;
        cheat.shooter.queue.push({
          seq,
          buttons: (seq % 2) * Button.Fire,
          yaw: 0,
          pitch,
          weaponSlot: 0,
          viewTick: cheat.sim.tick,
        });
      }
      cheat.sim.step();
      cheatShots += cheat.sim.lastShots.length;
    }
    expect(legitShots).toBe(10);
    expect(cheatShots).toBeLessThanOrEqual(legitShots);
  });

  it('walls block shots', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer();
    const target = sim.addPlayer();
    place(shooter, [0, 0, -10]);
    place(target, [0, 0, -24]); // behind the cover box at z=-20
    const shots = feed(sim, shooter, 3, Button.Fire, { pitch: aimPitch(1.67, 1.1, 14) });
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((s) => s.hit === null && s.wallDistance !== null)).toBe(true);
    expect(target.health).toBe(MAX_HEALTH);
  });

  it('no friendly fire', () => {
    const sim = newSim(arena);
    const a = sim.addPlayer(); // team 0
    sim.addPlayer(); // team 1 (unused)
    const mate = sim.addPlayer(); // team 0
    place(a, [0, 0, 10]);
    place(mate, [0, 0, 0]);
    feed(sim, a, 30, Button.Fire, { pitch: aimPitch(1.67, 1.1, 10) });
    expect(mate.health).toBe(MAX_HEALTH);
  });

  it('lag compensation: hits where the target WAS at the shooter view tick (within 200 ms)', () => {
    const { sim, shooter, target } = duel();
    // Record target standing at x=0 for a while, then teleport it 2 m to the side.
    aimIn(sim, shooter, aimPitch(1.67, 1.1, 10));
    place(target, [2, 0, 0]);
    sim.step();
    const pitch = aimPitch(1.67, 1.1, 10);
    // Shooter says "I was seeing the world 6 ticks ago" (100 ms): target was still at x=0.
    const seq = shooter.queue.lastProcessedSeq + shooter.queue.depth + 1;
    shooter.queue.push({
      seq,
      buttons: AIM_FIRE,
      yaw: 0,
      pitch,
      weaponSlot: 0,
      viewTick: sim.tick - 6,
    });
    sim.step();
    expect(sim.lastShots[0]?.hit?.victim).toBe(target.id);
  });

  it('never rewinds more than 200 ms, whatever the client claims', () => {
    const { sim, shooter, target } = duel();
    aimIn(sim, shooter, aimPitch(1.67, 1.1, 10));
    place(target, [2, 0, 0]);
    for (let i = 0; i < MAX_REWIND_TICKS + 5; i++) sim.step();
    const seq = shooter.queue.lastProcessedSeq + shooter.queue.depth + 1;
    shooter.queue.push({
      seq,
      buttons: AIM_FIRE,
      yaw: 0,
      pitch: aimPitch(1.67, 1.1, 10),
      weaponSlot: 0,
      viewTick: 0,
    });
    sim.step();
    expect(sim.lastShots[0]?.hit).toBeNull(); // the old position is outside the window
  });
});

describe('MatchSim: spawn protection', () => {
  it('ignores damage for 1.5 s after spawning, until the player fires', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer();
    const target = sim.addPlayer();
    place(shooter, [0, 0, 10]);
    target.sim = { ...target.sim, move: { ...createPlayerState([0, 0, 0], 0), grounded: true } };
    target.protectedUntil = sim.tick + 200;
    const pitch = aimPitch(1.67, 1.1, 10);
    aimIn(sim, shooter, pitch);
    feed(sim, shooter, 10, AIM_FIRE, { pitch });
    expect(target.health).toBe(MAX_HEALTH);
  });
});

describe('MatchSim: health', () => {
  it('regenerates 4 s after the last damage', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer();
    const target = sim.addPlayer();
    place(shooter, [0, 0, 10]);
    place(target, [0, 0, 0]);
    aimIn(sim, shooter, aimPitch(1.67, 1.1, 10));
    feed(sim, shooter, 1, AIM_FIRE, { pitch: aimPitch(1.67, 1.1, 10) });
    feed(sim, shooter, 2, Button.Aim, { pitch: aimPitch(1.67, 1.1, 10) });
    const hurt = target.health;
    expect(hurt).toBeLessThan(MAX_HEALTH);
    for (let i = 0; i < REGEN_DELAY_TICKS - 10; i++) sim.step();
    expect(target.health).toBe(hurt);
    for (let i = 0; i < 200; i++) sim.step();
    expect(target.health).toBe(MAX_HEALTH);
  });

  it('falling out of the map kills and respawns', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    place(p, [0, -30, 0]);
    feed(sim, p, 1, 0);
    expect(p.alive).toBe(false);
    expect(sim.events.some((e) => e.event.type === 'kill')).toBe(true);
  });
});

describe('MatchSim: performance', () => {
  it('ticks a full 12-player match with shooting well under the 4 ms budget', () => {
    const sim = newSim();
    const players = Array.from({ length: MAX_PLAYERS_PER_MATCH }, () => sim.addPlayer());
    let total = 0;
    for (let t = 0; t < 600; t++) {
      for (const p of players) {
        const seq = p.queue.lastProcessedSeq + p.queue.depth + 1;
        const buttons =
          (t % 120 < 80 ? Button.Forward : Button.Left) | (t % 3 === 0 ? Button.Fire : 0);
        p.queue.push({
          seq,
          buttons,
          yaw: (t * 50 + p.id * 3000) & 0xffff,
          pitch: 0,
          weaponSlot: 0,
          viewTick: sim.tick,
        });
      }
      sim.step();
      if (t > 60) total += sim.lastTickMicros;
    }
    expect(total / 539 / 1000).toBeLessThan(4);
  });
});
