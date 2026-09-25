import type { GameMap, Movement } from '@sentinel/content';
import type { EntityState, Snapshot } from '@sentinel/protocol';
import {
  MAX_PLAYERS_PER_MATCH,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  expandMap,
  removePlayerBody,
  step,
  yawFromDegrees,
  type MovementContext,
  type PlayerBody,
  type PlayerState,
  type Rapier,
} from '@sentinel/shared';
import { InputQueue } from './inputQueue.ts';

export interface SimPlayer {
  id: number;
  team: number;
  body: PlayerBody;
  state: PlayerState;
  queue: InputQueue;
}

/**
 * The authoritative match simulation, free of any networking so it can be tested directly.
 * MatchRoom feeds it inputs and turns its snapshots into bytes.
 */
export class MatchSim {
  tick = 0;
  lastTickMicros = 0;
  readonly players = new Map<number, SimPlayer>();
  private readonly ctx: MovementContext;
  private spawnCursor = [0, 0];

  constructor(
    rapier: Rapier,
    private readonly map: GameMap,
    tuning: Movement,
  ) {
    this.ctx = createMovementContext(rapier, buildWorld(rapier, expandMap(map)), tuning);
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS_PER_MATCH;
  }

  addPlayer(): SimPlayer {
    if (this.isFull) throw new Error('match is full');
    let id = 1;
    while (this.players.has(id)) id++;
    const teamCounts = [0, 0];
    for (const p of this.players.values()) teamCounts[p.team]!++;
    const team = teamCounts[0]! <= teamCounts[1]! ? 0 : 1;
    const player: SimPlayer = {
      id,
      team,
      body: createPlayerBody(this.ctx),
      state: this.spawnState(team),
      queue: new InputQueue(),
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    removePlayerBody(this.ctx, p.body);
    this.players.delete(id);
  }

  /** One fixed 1/60 s tick: every player advances exactly one step. */
  step(): void {
    const start = performance.now();
    for (const p of this.players.values()) {
      const input = p.queue.next();
      if (!input) continue; // still filling the start buffer
      p.state = step(p.state, input, this.ctx, p.body);
      if (p.state.position[1] < this.map.killY) p.state = this.spawnState(p.team);
    }
    this.tick++;
    this.lastTickMicros = (performance.now() - start) * 1000;
  }

  snapshotFor(id: number): Snapshot {
    const me = this.players.get(id);
    const entities: EntityState[] = [];
    for (const p of this.players.values()) {
      if (p.id === id) continue;
      entities.push({
        id: p.id,
        team: p.team,
        grounded: p.state.grounded,
        crouching: p.state.crouching,
        position: p.state.position,
        yaw: p.state.yaw,
        pitch: p.state.pitch,
      });
    }
    return {
      serverTick: this.tick,
      lastProcessedSeq: me?.queue.lastProcessedSeq ?? 0,
      inputQueueDepth: me?.queue.depth ?? 0,
      serverTickMicros: this.lastTickMicros,
      own: me
        ? {
            position: me.state.position,
            velocity: me.state.velocity,
            grounded: me.state.grounded,
            crouching: me.state.crouching,
            slideTicks: me.state.slideTicks,
            slideCooldownTicks: me.state.slideCooldownTicks,
            prevButtons: me.state.prevButtons,
          }
        : null,
      entities,
    };
  }

  private spawnState(team: number): PlayerState {
    const spawns = this.map.spawns.filter((s) => s.team === team);
    const spawn = spawns[this.spawnCursor[team]! % spawns.length]!;
    this.spawnCursor[team]!++;
    return createPlayerState(spawn.position, yawFromDegrees(spawn.yawDeg));
  }
}
