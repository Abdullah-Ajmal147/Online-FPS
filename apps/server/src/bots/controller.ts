import { MAX_PLAYERS_PER_MATCH, type Vec3 } from '@sentinel/shared';
import type { GameMap } from '@sentinel/content';
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
  readonly nav: NavGrid;
  private brains = new Map<number, BotBrain>();
  private nameCursor = 0;
  private seed = 1;

  constructor(
    private readonly sim: MatchSim,
    map: GameMap,
    private readonly difficulty: Difficulty,
    private readonly target = MAX_PLAYERS_PER_MATCH,
  ) {
    const ctx = sim.context.movement;
    this.nav = new NavGrid(ctx.rapier, ctx.world, ctx.tuning, mapBounds(map));
  }

  get count(): number {
    return this.brains.size;
  }

  /** Before each sim step: every bot decides its input for this tick. */
  think(): void {
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

  /** Team a joining human should take (the smaller one, counting bots). */
  teamForHuman(): number {
    const [a, b] = this.sim.teamCounts();
    return a <= b ? 0 : 1;
  }

  remove(id: number): void {
    this.brains.delete(id);
    this.sim.removePlayer(id);
  }

  private addBot(): SimPlayer {
    const name = `Bot ${CALLSIGNS[this.nameCursor++ % CALLSIGNS.length]}`;
    const p = this.sim.addPlayer({ name, bot: true });
    this.brains.set(p.id, new BotBrain(p, this.sim, this.nav, this.difficulty, this.seed++));
    return p;
  }

  private botOn(team: number): SimPlayer | undefined {
    return [...this.sim.players.values()].find((p) => p.bot && p.team === team);
  }
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
