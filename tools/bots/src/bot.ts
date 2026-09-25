import { Client, type Room } from '@colyseus/sdk';
import { defaultLoadout, maps, movement } from '@sentinel/content';
import {
  MessageType,
  PROTOCOL_VERSION,
  decodeEvents,
  decodeHello,
  decodePing,
  decodeSnapshot,
  encodeInputCmd,
  type GameEvent,
} from '@sentinel/protocol';
import {
  InterpolationDelay,
  Predictor,
  RemoteBuffer,
  ServerClock,
  TARGET_QUEUE_DEPTH,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  createSimContext,
  createWeaponState,
  expandMap,
  inputPacing,
  type PlayerInput,
  type Rapier,
  type RemotePose,
  type ShotRequest,
  type SimContext,
  type SimState,
} from '@sentinel/shared';

/** What a bot sees each tick to decide its input. */
export interface BotView {
  self: SimState;
  team: number;
  /** Other players as this bot draws them (interpolated, like a browser). */
  others: Map<number, RemotePose>;
  alive: boolean;
  ctx: SimContext;
}

export interface Brain {
  next(view: BotView): PlayerInput;
  /** Called with every shot this bot fired (after prediction), for measurement. */
  onShot?(shot: ShotRequest, view: BotView): void;
  onEvents?(events: GameEvent[]): void;
}

/**
 * One headless client: joins like a browser, runs the same prediction/reconciliation and remote
 * interpolation, and sends inputs only (never positions or hits).
 */
export class Bot {
  /** Created when Hello tells us the map. */
  predictor!: Predictor;
  ctx!: SimContext;
  private ready = false;
  id = 0;
  team = 0;
  spawned = false;
  alive = true;
  lifeId = -1;
  ack = 0;
  queueDepth = TARGET_QUEUE_DEPTH;
  accumulatorMs = 0;
  rttMs: number[] = [];
  readonly clock = new ServerClock();
  readonly interp = new InterpolationDelay();
  readonly remotes = new Map<number, RemoteBuffer>();
  readonly poses = new Map<number, RemotePose>();
  recorded: PlayerInput[] = [];

  private constructor(
    readonly name: string,
    readonly room: Room,
    readonly brain: Brain,
    private readonly rapier: Rapier,
  ) {
    this.listen();
  }

  /** Build our own copy of the server's map world (same code, same colliders). */
  private loadMap(mapId: string): void {
    const map = maps[mapId];
    if (!map) throw new Error(`${this.name}: server runs unknown map "${mapId}"`);
    const world = buildWorld(this.rapier, expandMap(map));
    const moveCtx = createMovementContext(this.rapier, world, movement);
    this.ctx = createSimContext(moveCtx, defaultLoadout);
    this.predictor = new Predictor(
      { move: createPlayerState([0, 0, 0], 0), weapon: createWeaponState(this.ctx.loadout) },
      this.ctx,
      createPlayerBody(moveCtx),
    );
    this.ready = true;
  }

  static async join(opts: {
    name: string;
    url: string;
    room?: string;
    brain: Brain;
    rapier: Rapier;
  }): Promise<Bot> {
    const client = new Client(opts.url);
    const options = { protocolVersion: PROTOCOL_VERSION };
    const room = opts.room
      ? await client.joinById(opts.room, options)
      : await client.joinOrCreate('match', options);
    return new Bot(opts.name, room, opts.brain, opts.rapier);
  }

  private listen(): void {
    this.room.onMessage(MessageType.Hello, (bytes: Uint8Array) => {
      const hello = decodeHello(bytes);
      this.id = hello.playerId;
      this.team = hello.team;
      this.loadMap(hello.mapId);
    });
    this.room.onMessage(MessageType.Snapshot, (bytes: Uint8Array) => {
      if (!this.ready) return;
      const snap = decodeSnapshot(bytes);
      if (snap.serverTick <= this.ack) return;
      const now = performance.now();
      this.ack = snap.serverTick;
      this.queueDepth += (snap.inputQueueDepth - this.queueDepth) * 0.1;
      this.clock.onSnapshot(snap.serverTick, now);
      this.interp.onSnapshotArrival(now);
      for (const e of snap.entities) {
        let buf = this.remotes.get(e.id);
        if (!buf) this.remotes.set(e.id, (buf = new RemoteBuffer()));
        buf.push(snap.serverTick, e);
      }
      const present = new Set(snap.entities.map((e) => e.id));
      for (const id of this.remotes.keys()) if (!present.has(id)) this.remotes.delete(id);
      const own = snap.own;
      if (!own) return;
      this.alive = own.respawnTicks === 0;
      if (!this.spawned || own.lifeId !== this.lifeId) {
        const joining = !this.spawned;
        this.spawned = true;
        this.lifeId = own.lifeId;
        this.predictor.reset(
          { move: { ...own.sim.move, yaw: 0, pitch: 0 }, weapon: own.sim.weapon },
          joining ? undefined : snap.lastProcessedSeq,
        );
      } else if (this.alive) {
        this.predictor.onServerState(own.sim, snap.lastProcessedSeq);
      }
    });
    this.room.onMessage(MessageType.Events, (bytes: Uint8Array) =>
      this.brain.onEvents?.(decodeEvents(bytes)),
    );
    this.room.onMessage(MessageType.Pong, (bytes: Uint8Array) => {
      this.rttMs.push(((Math.floor(performance.now()) >>> 0) - decodePing(bytes)) >>> 0);
    });
  }

  /** Advance by `elapsedMs` of wall time: 60 Hz ticks, paced like the browser client. */
  update(elapsedMs: number, record: boolean): void {
    if (!this.spawned) return;
    const serverNow = this.clock.now(performance.now());
    const viewTick = serverNow === null ? 0 : Math.max(0, serverNow - this.interp.ticks);
    this.poses.clear();
    for (const [id, buf] of this.remotes) {
      const pose = buf.sample(viewTick);
      if (pose) this.poses.set(id, pose);
    }
    this.accumulatorMs += elapsedMs * inputPacing(this.queueDepth);
    while (this.accumulatorMs >= 1000 / 60) {
      this.accumulatorMs -= 1000 / 60;
      const view: BotView = {
        self: this.predictor.state,
        team: this.team,
        others: this.poses,
        alive: this.alive,
        ctx: this.ctx,
      };
      const input = this.brain.next(view);
      if (record) this.recorded.push(input);
      const { shot } = this.predictor.tick(
        { ...input, weaponSlot: input.weaponSlot ?? 0, viewTick },
        { skip: !this.alive }, // dead: the server consumes but doesn't step our inputs
      );
      if (shot && this.alive) this.brain.onShot?.(shot, view);
      this.room.sendBytes(
        MessageType.InputCmd,
        encodeInputCmd({ ackServerTick: this.ack, inputs: this.predictor.recentInputs() }),
      );
    }
  }
}
