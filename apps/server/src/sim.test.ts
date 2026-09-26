import { beforeAll, describe, expect, it } from 'vitest';
import {
  defaultLoadout,
  maps,
  movement,
  KILL_SOURCE_FRAG,
  equipment,
  resolveLoadout,
  weaponIndex,
  weapons,
  type GameMap,
} from '@sentinel/content';
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
  governViewTick,
  type SimPlayer,
} from './sim.ts';
import { MAX_PROJECTILES } from './grenades.ts';

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

  it('lag compensation: hits where the target WAS at the shooter view tick (within the 300 ms cap)', () => {
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

  it('never rewinds more than 300 ms, whatever the client claims', () => {
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

describe('MatchSim: loadouts', () => {
  it('simulates each player with their own weapons and reports them on the wire', () => {
    const sim = newSim(arena);
    const smg = sim.addPlayer({ loadout: resolveLoadout('vireo-smg', 'wren-sp') });
    const other = sim.addPlayer();
    expect(smg.ctx.loadout[0].def.id).toBe('vireo-smg');
    expect(smg.sim.weapon.ammo[0].ammo).toBe(weapons['vireo-smg']!.magazine);
    expect(sim.snapshotFor(smg.id).own?.loadout).toEqual([
      weaponIndex('vireo-smg'),
      weaponIndex('wren-sp'),
    ]);
    const seen = sim.snapshotFor(other.id).entities.find((e) => e.id === smg.id);
    expect(seen?.weapon).toBe(weaponIndex('vireo-smg'));
  });

  it('a new loadout applies only at the next spawn, never mid-life', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    sim.setLoadout(p.id, resolveLoadout('halberd-mr', 'wren-sp'));
    sim.step();
    expect(p.ctx.loadout[0].def.id).toBe('kestrel-ar');
    sim.respawnAll();
    expect(p.ctx.loadout[0].def.id).toBe('halberd-mr');
    expect(p.loadout[0]).toBe(weaponIndex('halberd-mr'));
    expect(p.sim.weapon.ammo[0].ammo).toBe(weapons['halberd-mr']!.magazine);
  });

  it('shotgun: pellet damage adds up into one hit, one-shot kill up close', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer({ loadout: resolveLoadout('thresher-12', 'wren-sp') });
    const target = sim.addPlayer();
    place(shooter, [0, 0, 3]);
    place(target, [0, 0, 0]);
    const pitch = aimPitch(1.67, 1.1, 3);
    aimIn(sim, shooter, pitch);
    const events = [];
    const shots = [];
    for (let i = 0; i < 3 && target.alive; i++) {
      shots.push(...feed(sim, shooter, 1, AIM_FIRE, { pitch }));
      events.push(...sim.events.filter((e) => e.event.type === 'hit'));
    }
    expect(shots).toHaveLength(weapons['thresher-12']!.pellets);
    expect(events).toHaveLength(1);
    expect(target.alive).toBe(false);
    const kill = sim.events.find((e) => e.event.type === 'kill')?.event;
    expect(kill).toMatchObject({ weapon: weaponIndex('thresher-12') });
  });

  it('shotgun: at long range the pellets spread and fall off, far from a kill', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer({ loadout: resolveLoadout('thresher-12', 'wren-sp') });
    const target = sim.addPlayer();
    place(shooter, [0, 0, 25]);
    place(target, [0, 0, 0]);
    const pitch = aimPitch(1.67, 1.1, 25);
    aimIn(sim, shooter, pitch);
    feed(sim, shooter, 2, AIM_FIRE, { pitch });
    expect(target.alive).toBe(true);
    expect(target.health).toBeGreaterThan(60);
  });
});

describe('MatchSim: grenades', () => {
  /** Press a button for one tick, then release, then let the world run. */
  function throwOnce(sim: MatchSim, p: SimPlayer, button: number, pitch = 0) {
    feed(sim, p, 1, 0, { pitch });
    feed(sim, p, 1, button, { pitch });
    feed(sim, p, 1, 0, { pitch });
  }
  const fuse = (e: typeof equipment.frag) => Math.round(e.fuseTime * 60) + 10;

  it('a frag at the feet kills an enemy, spares a teammate, and credits the thrower', () => {
    const sim = newSim(arena);
    const thrower = sim.addPlayer({ team: 0 });
    const enemy = sim.addPlayer({ team: 1 });
    const mate = sim.addPlayer({ team: 0 });
    place(thrower, [0, 0, 12]);
    place(enemy, [0, 0, 0]);
    place(mate, [1, 0, 0]);
    // Throw straight down at the enemy's feet: aim steeply at a point just in front of them.
    const events: string[] = [];
    let kill: unknown;
    throwOnce(sim, thrower, Button.Lethal, aimPitch(1.67, 0.3, 11));
    expect(thrower.frags).toBe(0);
    expect(sim.grenades.list).toHaveLength(1);
    for (let i = 0; i < fuse(equipment.frag); i++) {
      sim.step();
      for (const e of sim.events) {
        events.push(e.event.type);
        if (e.event.type === 'kill') kill = e.event;
      }
    }
    expect(events).toContain('explosion');
    expect(sim.grenades.list).toHaveLength(0);
    expect(enemy.alive).toBe(false);
    expect(mate.health).toBe(MAX_HEALTH);
    expect(kill).toMatchObject({ killer: thrower.id, weapon: KILL_SOURCE_FRAG });
  });

  it('damage is full inside the inner radius, none beyond the outer, and walls block it', () => {
    const sim = newSim(arena);
    const owner = sim.addPlayer({ team: 0 });
    const near = sim.addPlayer({ team: 1 });
    const far = sim.addPlayer({ team: 1 });
    const covered = sim.addPlayer({ team: 1 });
    place(owner, [20, 0, 20]);
    place(near, [0.5, 0, 0]);
    place(far, [0, 0, 8]);
    // The arena's cover wall spans x −2..2 at z = −20 (1 m thick): hide behind it.
    place(covered, [0, 0, -22]);
    const g = sim.grenades.throw(equipment.frag, owner.id, [0, 0.2, -18], [0, -1, 0], [0, 0, 0])!;
    g.velocity = [0, 0, 0];
    g.position = [0, 0.1, -18.2];
    g.fuseTicks = 1;
    const g2 = sim.grenades.throw(equipment.frag, owner.id, [0, 0.2, 0], [0, -1, 0], [0, 0, 0])!;
    g2.velocity = [0, 0, 0];
    g2.position = [0, 0.1, 0];
    g2.fuseTicks = 1;
    sim.step();
    expect(near.alive).toBe(false); // 130 at the centre
    expect(far.health).toBe(MAX_HEALTH); // 8 m > 6 m outer radius
    expect(covered.health).toBe(MAX_HEALTH); // wall between blast and chest
  });

  it('your own frag hurts you (half) and a self-kill scores nothing', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer({ team: 0 });
    sim.addPlayer({ team: 1 });
    place(p, [0, 0, 0]);
    p.health = 40;
    const g = sim.grenades.throw(equipment.frag, p.id, [0, 0.2, 0], [0, -1, 0], [0, 0, 0])!;
    g.velocity = [0, 0, 0];
    g.position = [0, 0.1, 0];
    g.fuseTicks = 1;
    sim.step();
    expect(p.alive).toBe(false);
    expect(p.kills).toBe(0);
    expect(p.deaths).toBe(1);
    expect(sim.events.some((e) => e.event.type === 'hit')).toBe(false);
  });

  it('one frag and one smoke per life, refilled on respawn; holding G throws once', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    place(p, [0, 0, 0]);
    feed(sim, p, 2, 0);
    feed(sim, p, 10, Button.Lethal); // held: one throw
    expect(p.frags).toBe(0);
    expect(sim.grenades.list).toHaveLength(1);
    feed(sim, p, 40, 0); // wait out the throw cooldown
    feed(sim, p, 10, Button.Tactical);
    expect(p.smokes).toBe(0);
    expect(sim.grenades.list).toHaveLength(2);
    sim.respawnAll();
    expect(p.frags).toBe(equipment.frag.perLife);
    expect(p.smokes).toBe(equipment.smoke.perLife);
    expect(sim.grenades.list).toHaveLength(0);
  });

  it('G held through a respawn does not throw until released and pressed again', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    place(p, [0, 0, 0]);
    feed(sim, p, 30, Button.Lethal); // held since spawn
    expect(sim.grenades.list).toHaveLength(0);
    feed(sim, p, 1, 0);
    feed(sim, p, 1, Button.Lethal);
    feed(sim, p, 1, Button.Lethal);
    expect(sim.grenades.list).toHaveLength(1);
  });

  it('frag and smoke pressed together: only the frag, then a cooldown before the smoke', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    place(p, [0, 0, 0]);
    feed(sim, p, 2, 0);
    feed(sim, p, 1, Button.Lethal | Button.Tactical);
    feed(sim, p, 1, 0);
    expect(p.frags).toBe(0);
    expect(p.smokes).toBe(1);
    feed(sim, p, 1, Button.Tactical); // inside the cooldown: ignored
    feed(sim, p, 1, 0);
    expect(p.smokes).toBe(1);
    feed(sim, p, Math.round(equipment.frag.cooldown * 60), 0);
    feed(sim, p, 1, Button.Tactical);
    feed(sim, p, 1, 0);
    expect(p.smokes).toBe(0);
  });

  it('nobody throws while dead or during the frozen countdown', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    place(p, [0, 0, 0]);
    feed(sim, p, 2, 0);
    sim.frozen = true;
    feed(sim, p, 1, Button.Lethal);
    feed(sim, p, 1, 0);
    expect(sim.grenades.list).toHaveLength(0);
    sim.frozen = false;
    p.alive = false;
    feed(sim, p, 1, Button.Lethal);
    expect(sim.grenades.list).toHaveLength(0);
  });

  it('caps live grenades (the snapshot count is one byte)', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      expect(
        sim.grenades.throw(equipment.smoke, p.id, [0, 1, 0], [0, 1, 0], [0, 0, 0]),
      ).not.toBeNull();
    }
    expect(sim.grenades.throw(equipment.frag, p.id, [0, 1, 0], [0, 1, 0], [0, 0, 0])).toBeNull();
  });

  it('an enemy hidden by smoke is left out of your snapshot; teammates never are', () => {
    const sim = newSim(arena);
    const me = sim.addPlayer({ team: 0 });
    const enemy = sim.addPlayer({ team: 1 });
    const mate = sim.addPlayer({ team: 0 });
    place(me, [0, 0, 10]);
    place(enemy, [0, 0, -10]);
    place(mate, [0.5, 0, -10]);
    const ids = () => sim.snapshotFor(me.id).entities.map((e) => e.id);
    expect(ids()).toContain(enemy.id);
    const g = sim.grenades.throw(equipment.smoke, me.id, [0, 1, 0], [0, -1, 0], [0, 0, 0])!;
    g.velocity = [0, 0, 0];
    g.position = [0, 0.1, 0];
    g.fuseTicks = 1;
    sim.step();
    expect(ids()).not.toContain(enemy.id);
    expect(ids()).toContain(mate.id);
    // The enemy's own view of us is blocked the same way (symmetric).
    expect(sim.snapshotFor(enemy.id).entities.map((e) => e.id)).not.toContain(me.id);
  });

  it('a smoke cloud blocks line of sight (bots cannot see through it), then clears', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    const g = sim.grenades.throw(equipment.smoke, p.id, [0, 1, 0], [0, -1, 0], [0, 0, 0])!;
    g.velocity = [0, 0, 0];
    g.position = [0, 0.1, 5];
    g.fuseTicks = 1;
    const a: Vec3 = [-10, 1.5, 5];
    const b: Vec3 = [10, 1.5, 5];
    expect(sim.lineOfSight(a, b)).toBe(true);
    sim.step();
    expect(sim.events.map((e) => e.event.type)).toContain('explosion');
    expect(sim.lineOfSight(a, b)).toBe(false);
    expect(sim.snapshotFor(p.id).projectiles).toMatchObject([{ kind: 'smoke', cloud: true }]);
    for (let i = 0; i < equipment.smoke.smoke!.duration * 60; i++) sim.step();
    expect(sim.lineOfSight(a, b)).toBe(true);
  });

  it('a grenade thrown into a wall bounces back instead of passing through', () => {
    const sim = newSim(arena);
    const p = sim.addPlayer();
    // Cover wall front face is at z = −19.5; throw at it from 3 m away, flat.
    const g = sim.grenades.throw(equipment.frag, p.id, [0, 2, -16.5], [0, 0, -1], [0, 0, 0])!;
    g.velocity = [0, 0, -17];
    for (let i = 0; i < 60; i++) {
      sim.step();
      expect(g.position[2]).toBeGreaterThan(-19.5);
    }
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

describe('MatchSim: scavenging', () => {
  it('a kill refills one magazine of reserve ammo (capped)', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer();
    const target = sim.addPlayer();
    place(shooter, [0, 0, 10]);
    place(target, [0, 0, 0]);
    shooter.sim = {
      ...shooter.sim,
      weapon: {
        ...shooter.sim.weapon,
        ammo: [
          { ammo: 30, reserve: 10 },
          { ammo: 12, reserve: 48 },
        ],
      },
    };
    target.health = 5;
    target.lastDamageTick = sim.tick;
    const pitch = aimPitch(1.67, 1.1, 10);
    aimIn(sim, shooter, pitch);
    for (let i = 0; i < 30 && target.alive; i++) feed(sim, shooter, 1, AIM_FIRE, { pitch });
    expect(target.alive).toBe(false);
    expect(shooter.sim.weapon.ammo[0].reserve).toBe(10 + defaultLoadout[0].magazine);
    expect(shooter.sim.weapon.ammo[1].reserve).toBe(defaultLoadout[1].reserve); // already full
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

describe('MatchSim: review fixes', () => {
  it('governViewTick: forward freely, back only slowly (per-shot backtrack refused)', () => {
    const g = { last: null as number | null };
    expect(governViewTick(g, 96)).toBe(96); // baseline
    expect(governViewTick(g, 97)).toBe(97);
    expect(governViewTick(g, 80)).toBe(96.75); // "backtrack" 17 ticks: refused
    // A 10 fps client: 6 inputs per frame share one view tick, then it jumps ahead. Honest, allowed.
    const low = { last: null as number | null };
    for (let frame = 0; frame < 5; frame++) {
      for (let i = 0; i < 6; i++)
        expect(governViewTick(low, 100 + frame * 6)).toBe(100 + frame * 6);
    }
  });

  it('a client steadily ~2 ticks behind cannot suddenly rewind 17 ticks for one shot', () => {
    const sim = newSim(arena);
    const shooter = sim.addPlayer();
    const target = sim.addPlayer();
    place(shooter, [0, 0, 10]);
    place(target, [0, 0, 0]);
    const pitch = aimPitch(1.67, 1.1, 10);
    aimIn(sim, shooter, pitch); // viewTick = sim.tick each input: ~steady
    place(target, [3, 0, 0]); // target moved away (it was on the line 17 ticks ago)
    for (let i = 0; i < 20; i++) feed(sim, shooter, 1, Button.Aim, { pitch });
    const seq = shooter.queue.lastProcessedSeq + shooter.queue.depth + 1;
    shooter.queue.push({
      seq,
      buttons: AIM_FIRE,
      yaw: 0,
      pitch,
      weaponSlot: 0,
      viewTick: sim.tick - 17,
    });
    sim.step();
    sim.step();
    expect(sim.lastShots.concat().every((s) => s.hit === null)).toBe(true);
    expect(target.health).toBe(MAX_HEALTH);
  });

  it('same-tick trade: both lethal shots count, whoever joined first', () => {
    const sim = newSim(arena);
    const a = sim.addPlayer(); // id 1, team 0
    const b = sim.addPlayer(); // id 2, team 1
    place(a, [0, 0, 10]);
    place(b, [0, 0, 0]);
    b.sim = { ...b.sim, move: { ...b.sim.move, yaw: 32768 } }; // b faces +Z towards a
    const pa = aimPitch(1.67, 1.1, 10);
    // Both aim in, then fire on the same tick.
    for (let i = 0; i < 22; i++) {
      for (const [p, yaw, fire] of [
        [a, 0, i >= 20],
        [b, 32768, i >= 20],
      ] as const) {
        const seq = p.queue.lastProcessedSeq + p.queue.depth + 1;
        p.queue.push({
          seq,
          buttons: Button.Aim | (fire ? Button.Fire : 0),
          yaw,
          pitch: pa,
          weaponSlot: 0,
          viewTick: sim.tick,
        });
        if (i === 0)
          p.queue.push({
            seq: seq + 1,
            buttons: Button.Aim,
            yaw,
            pitch: pa,
            weaponSlot: 0,
            viewTick: sim.tick,
          });
      }
      if (i === 19) {
        // One shot from lethal, and no regeneration before the trade.
        for (const p of [a, b]) {
          p.health = 10;
          p.lastDamageTick = sim.tick;
        }
      }
      sim.step();
      if (!a.alive || !b.alive) break;
    }
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
  });
});
