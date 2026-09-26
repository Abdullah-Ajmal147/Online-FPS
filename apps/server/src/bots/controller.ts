import {
  MAX_PLAYERS_PER_MATCH,
  buildWorld,
  expandMap,
  type Rapier,
  type Vec3,
} from '@sentinel/shared';
import { resolveLoadout, type GameMap, type Movement } from '@sentinel/content';
import type { MatchSim, SimPlayer } from '../sim.ts';
import { BotBrain, type Difficulty } from './brain.ts';
import { NavGrid } from './nav.ts';

/** Original bot callsigns (no real people, no other game's names). */
const CALLSIGNS = [
  'Heron',
  'Flint',
  'Sable',
  'Quill',
  'Rook',
  'Tansy',
  'Vesper',
  'Juno',
  'Kite',
  'Lark',
  'Moss',
  'Orin',
  'Pike',
  'Rune',
  'Sorrel',
  'Tarn',
];

/**
 * Keeps every match full (Phase 3): bots fill empty slots up to 12, keep teams even, and
 * make room when a human joins. Each tick it asks every bot's brain for an input.
 */
export class BotController {
  nav: NavGrid;
  private brains = new Map<number, BotBrain>();
  private nameCursor = 0;
  private seed = 1;

  constructor(
    private readonly sim: MatchSim,
    map: GameMap,
    private readonly difficulty: Difficulty,
    private readonly target = MAX_PLAYERS_PER_MATCH,
  ) {
    this.nav = navFor(sim, map);
  }

  /** New map (rotation): new grid, fresh brains (their plans were for the old map). */
  setMap(map: GameMap): void {
    this.nav = navFor(this.sim, map);
    for (const id of this.brains.keys()) {
      const p = this.sim.players.get(id);
      if (!p) continue;
      this.brains.set(
        id,
        new BotBrain(p, this.sim, this.nav, this.difficulty, this.seed++, this.planBudget),
      );
    }
  }

  get count(): number {
    return this.brains.size;
  }

  /** Before each sim step: every bot decides its input for this tick. */
  /** Path searches allowed per tick across all bots. */
  static readonly PLANS_PER_TICK = 2;
  private readonly planBudget = { left: BotController.PLANS_PER_TICK };

  think(): void {
    this.planBudget.left = BotController.PLANS_PER_TICK;
    for (const [id, brain] of this.brains) {
      const p = this.sim.players.get(id);
      if (p) p.botInput = brain.think();
    }
  }

  /** Add bots until the match has `target` players, onto the smaller team. */
  fill(): void {
    while (this.sim.players.size < this.target) this.addBot();
  }

  /**
   * A human is joining: make room if full by removing a bot from the team the human will join,
   * so teams stay even.
   */
  makeRoomFor(team: number): void {
    if (this.sim.players.size < this.target) return;
    const bot = this.botOn(team) ?? this.botOn(1 - team);
    if (bot) this.remove(bot.id);
  }

  /**
   * Team for a joining human: the one with fewer humans (so real players spread out and don't
   * end up all on one side against bots), then the one with fewer players overall. In a full
   * match that team always still has a bot to swap out, so teams stay 6v6.
   */
  teamForHuman(): number {
    const humans: [number, number] = [0, 0];
    for (const p of this.sim.players.values()) if (!p.bot) humans[p.team as 0 | 1]++;
    if (humans[0] !== humans[1]) return humans[0] < humans[1] ? 0 : 1;
    const [a, b] = this.sim.teamCounts();
    return a <= b ? 0 : 1;
  }

  remove(id: number): void {
    this.brains.delete(id);
    this.sim.removePlayer(id);
  }

  private addBot(): SimPlayer {
    const name = `Bot ${CALLSIGNS[this.nameCursor++ % CALLSIGNS.length]}`;
    // Bots carry a mix of primaries (per difficulty) so fights vary. No shotgun: bot tactics
    // don't close distance on purpose, so it would only make them weaker.
    // Cycle per team (the n-th bot on each team gets the same weapon), so both teams carry the
    // same mix; a global cycle would line up with team alternation and arm one team better.
    const [a, b] = this.sim.teamCounts();
    const team = a <= b ? 0 : 1;
    const onTeam = [...this.sim.players.values()].filter((p) => p.bot && p.team === team).length;
    const pool = this.difficulty.primaries;
    const primary = pool[onTeam % pool.length];
    const p = this.sim.addPlayer({
      name,
      bot: true,
      team,
      loadout: resolveLoadout(primary, 'wren-sp'),
    });
    this.brains.set(
      p.id,
      new BotBrain(p, this.sim, this.nav, this.difficulty, this.seed++, this.planBudget),
    );
    return p;
  }

  private botOn(team: number): SimPlayer | undefined {
    return [...this.sim.players.values()].find((p) => p.bot && p.team === team);
  }
}

/**
 * Nav grids per map, built once per process: building one blocks the event loop for a few
 * hundred ms, which must not happen every time a room opens. The grid only depends on the
 * static map geometry, so every room on that map can share it.
 */
const navCache = new Map<string, NavGrid>();

/**
 * Build (and cache) the grid for a map that isn't loaded yet, in a throwaway physics world.
 * Rooms call this for every map in their rotation when they open, so a map change later never
 * blocks the tick loop for the few hundred ms a grid takes.
 */
export function prewarmNav(rapier: Rapier, tuning: Movement, map: GameMap): void {
  if (navCache.has(map.id)) return;
  const world = buildWorld(rapier, expandMap(map));
  navCache.set(map.id, new NavGrid(rapier, world, tuning, mapBounds(map)));
  world.free(); // the grid keeps no reference to the world
}

function navFor(sim: MatchSim, map: GameMap): NavGrid {
  let nav = navCache.get(map.id);
  if (!nav) {
    const ctx = sim.context.movement;
    nav = new NavGrid(ctx.rapier, ctx.world, ctx.tuning, mapBounds(map));
    navCache.set(map.id, nav);
  }
  return nav;
}

/** The map's floor extent (from its geometry), for the nav grid. */
export function mapBounds(map: GameMap): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const g of map.geometry) {
    if (g.kind !== 'box') continue;
    const [x, , z] = g.center as Vec3;
    const [sx, , sz] = g.size;
    const half = g.yawDeg === 90 || g.yawDeg === 270 ? [sz / 2, sx / 2] : [sx / 2, sz / 2];
    minX = Math.min(minX, x - half[0]!);
    maxX = Math.max(maxX, x + half[0]!);
    minZ = Math.min(minZ, z - half[1]!);
    maxZ = Math.max(maxZ, z + half[1]!);
  }
  return { minX, maxX, minZ, maxZ };
}
