import { movement } from '@sentinel/content';
import {
  Button,
  SKIN,
  TICK_RATE,
  capsuleHeight,
  createRng,
  pitchFromRadians,
  yawFromRadians,
  type Vec3,
} from '@sentinel/shared';
import type { TickInput } from '../inputQueue.ts';
import type { MatchSim, SimPlayer } from '../sim.ts';
import type { NavGrid } from './nav.ts';

export interface Difficulty {
  /** Time from first seeing an enemy to the first shot. */
  reactionMs: number;
  /** Initial aim error when acquiring a target (degrees); shrinks while tracking. */
  aimErrorDeg: number;
  /** Fraction of the aim error removed per second of tracking. */
  trackingPerSecond: number;
  /** Max turn speed (degrees per second). */
  turnDegPerSecond: number;
  /** Fraction of its own recoil the bot pulls against (0–1). */
  recoilControl: number;
  /** Fires only when the aim is within this many degrees of the aim point. */
  fireToleranceDeg: number;
}

/**
 * Bot skill. "normal" (default) is tuned to be beatable by a casual player: noticeable reaction
 * time, an aim error that shrinks while tracking (early shots miss), limited recoil control.
 * "hard" is the challenge setting.
 */
export const DIFFICULTIES: Record<'easy' | 'normal' | 'hard', Difficulty> = {
  easy: {
    reactionMs: 650,
    aimErrorDeg: 9,
    trackingPerSecond: 0.6,
    turnDegPerSecond: 200,
    recoilControl: 0.2,
    fireToleranceDeg: 4,
  },
  normal: {
    reactionMs: 480,
    aimErrorDeg: 7,
    trackingPerSecond: 0.9,
    turnDegPerSecond: 300,
    recoilControl: 0.4,
    fireToleranceDeg: 3,
  },
  hard: {
    reactionMs: 240,
    aimErrorDeg: 3,
    trackingPerSecond: 2,
    turnDegPerSecond: 600,
    recoilControl: 0.85,
    fireToleranceDeg: 1.5,
  },
};

const DEG = Math.PI / 180;
const VIEW_RANGE = 70;
const HALF_FOV = 65 * DEG;

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * One server bot's decisions. Every tick it produces an input exactly like a player's
 * (buttons + view angles); the shared simulation then moves it and fires its weapon, so bots
 * obey the same rules as humans (fire rate, ammo, recoil, spread, movement).
 */
export class BotBrain {
  private yaw = 0; // radians, current view
  private pitch = 0;
  private path: Vec3[] = [];
  private stuckTicks = 0;
  private lastPos: Vec3 = [0, 0, 0];
  private targetId = 0;
  private reactionLeft = 0;
  private errYaw = 0;
  private errPitch = 0;
  private strafeLeft = true;
  private strafeTicks = 0;
  private jumpCooldown = 0;
  private lastLifeId = -1;
  private readonly random: () => number;

  constructor(
    private readonly self: SimPlayer,
    private readonly sim: MatchSim,
    private readonly nav: NavGrid,
    private readonly diff: Difficulty,
    seed: number,
    /** Path searches left this tick, shared by all bots (keeps tick time flat). */
    private readonly planBudget: { left: number } = { left: Infinity },
  ) {
    this.random = createRng(seed);
  }

  think(): TickInput {
    const me = this.self;
    const tick = this.sim.tick;
    if (me.lifeId !== this.lastLifeId) {
      // (Re)spawned: face where the spawn faces, forget the old plan.
      this.lastLifeId = me.lifeId;
      this.yaw = (me.sim.move.yaw / 65536) * 2 * Math.PI;
      this.pitch = 0;
      this.path = [];
      this.targetId = 0;
    }
    if (!me.alive || this.sim.frozen) return this.input(0, tick);

    const eye = this.sim.eyeOf(me);
    const target = this.pickTarget(eye);
    let buttons = 0;
    const w = me.sim.weapon;
    const mag = w.ammo[w.slot];

    if (target) {
      if (target.id !== this.targetId) {
        // New target: react after a delay, start with an aim error that shrinks while tracking.
        this.targetId = target.id;
        this.reactionLeft = Math.round(
          (this.diff.reactionMs * (0.8 + 0.4 * this.random())) / (1000 / TICK_RATE),
        );
        const e = this.diff.aimErrorDeg * DEG;
        const a = this.random() * 2 * Math.PI;
        this.errYaw = Math.cos(a) * e;
        this.errPitch = Math.sin(a) * e * 0.6;
      }
      const aim = aimPoint(target);
      const dx = aim[0] - eye[0];
      const dy = aim[1] - eye[1];
      const dz = aim[2] - eye[2];
      const dist = Math.hypot(dx, dz);
      // Pull against our own recoil (the view we set + recoil = where the shot goes).
      const recoilYaw = (w.recoilYaw / 65536) * 2 * Math.PI * this.diff.recoilControl;
      const recoilPitch = (w.recoilPitch / 65536) * 2 * Math.PI * this.diff.recoilControl;
      const wantYaw = Math.atan2(-dx, -dz) + this.errYaw - recoilYaw;
      const wantPitch = Math.atan2(dy, dist) + this.errPitch - recoilPitch;
      this.turnTowards(wantYaw, wantPitch);
      const decay = Math.max(0, 1 - this.diff.trackingPerSecond / TICK_RATE);
      this.errYaw *= decay;
      this.errPitch *= decay;

      if (this.reactionLeft > 0) this.reactionLeft--;
      const offBy = Math.hypot(wrapAngle(wantYaw - this.yaw), wantPitch - this.pitch) / DEG;
      // Semi-automatic weapons fire once per press: release the trigger every other tick.
      const semi = me.ctx.loadout[w.slot].def.fireMode === 'semi';
      const held = (me.sim.move.prevButtons & Button.Fire) !== 0;
      if (
        this.reactionLeft === 0 &&
        offBy < this.diff.fireToleranceDeg &&
        mag.ammo > 0 &&
        !(semi && held)
      )
        buttons |= Button.Fire;
      if (dist > 12) buttons |= Button.Aim;
      // Strafe while fighting.
      if (--this.strafeTicks <= 0) {
        this.strafeLeft = this.random() < 0.5;
        this.strafeTicks = 30 + Math.floor(this.random() * 60);
      }
      buttons |= this.strafeLeft ? Button.Left : Button.Right;
      if (dist > 25) buttons |= Button.Forward;
      this.path = [];
    } else {
      this.targetId = 0;
      buttons |= this.roam(me);
      // Out of a fight with a half-empty magazine: top up.
      const magazine = me.ctx.loadout[w.slot].def.magazine;
      if (mag.ammo < magazine / 2 && mag.reserve > 0) buttons |= Button.Reload;
    }
    if (mag.ammo === 0) buttons |= Button.Reload;
    return this.input(buttons, tick);
  }

  private input(buttons: number, tick: number): TickInput {
    return {
      buttons,
      yaw: yawFromRadians(this.yaw),
      pitch: pitchFromRadians(this.pitch),
      weaponSlot: 0,
      viewTick: tick, // bots see the server's present, so no rewind
    };
  }

  /** Closest visible living enemy in view (or anyone who is very close). */
  private pickTarget(eye: Vec3): SimPlayer | null {
    let best: SimPlayer | null = null;
    let bestD = Infinity;
    for (const p of this.sim.players.values()) {
      if (p.team === this.self.team || !p.alive) continue;
      const pos = p.sim.move.position;
      const dx = pos[0] - eye[0];
      const dz = pos[2] - eye[2];
      const d = Math.hypot(dx, dz);
      if (d > VIEW_RANGE || d >= bestD) continue;
      const angle = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - this.yaw));
      if (angle > HALF_FOV && d > 6 && p.id !== this.targetId) continue;
      if (!this.sim.lineOfSight(eye, aimPoint(p))) continue;
      best = p;
      bestD = d;
    }
    return best;
  }

  private hunting = false;
  private pathAge = 0;
  private planCooldown = 0;

  /**
   * Where to go next. Mostly towards the fight: near a random living enemy (60%) or the middle
   * of the map (25%), otherwise anywhere — so matches have constant action instead of bots
   * wandering the edges. (Bots know roughly where enemies are, like a radar ping would.)
   */
  private pickGoal(pos: Vec3): Vec3 {
    const cells = this.nav.walkableCells();
    const nearCell = (x: number, z: number, radius: number): Vec3 => {
      for (let tries = 0; tries < 6; tries++) {
        const [i, j] = cells[Math.floor(this.random() * cells.length)]!;
        const [cx, cz] = this.nav.center(i, j);
        if (Math.hypot(cx - x, cz - z) <= radius) return [cx, 0, cz];
      }
      return [x, 0, z];
    };
    const r = this.random();
    const enemies = [...this.sim.players.values()].filter(
      (p) => p.team !== this.self.team && p.alive,
    );
    if (r < 0.6 && enemies.length > 0) {
      const e = enemies[Math.floor(this.random() * enemies.length)]!.sim.move.position;
      this.hunting = true;
      return nearCell(e[0], e[2], 8);
    }
    this.hunting = false;
    if (r < 0.85) return nearCell(0, 0, 12);
    const [i, j] = cells[Math.floor(this.random() * cells.length)]!;
    const [x, z] = this.nav.center(i, j);
    void pos;
    return [x, 0, z];
  }

  private turnTowards(yaw: number, pitch: number): void {
    const max = (this.diff.turnDegPerSecond * DEG) / TICK_RATE;
    const dy = wrapAngle(yaw - this.yaw);
    this.yaw = wrapAngle(this.yaw + Math.max(-max, Math.min(max, dy)));
    const dp = pitch - this.pitch;
    this.pitch += Math.max(-max, Math.min(max, dp));
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
  }

  /** Walk to random points on the map, sprinting; jump or re-plan if stuck. */
  private roam(me: SimPlayer): number {
    const pos = me.sim.move.position;
    // Hunters re-plan every few seconds: their quarry moves.
    if (this.hunting && ++this.pathAge > HUNT_REPLAN_TICKS) this.path = [];
    if (this.path.length === 0) {
      // One search per bot per tick at most, and only while the shared budget lasts: when many
      // bots need a plan at once (respawn, match start) they spread over a few ticks.
      if (this.planCooldown > 0) {
        // A plan just failed: step back from whatever we're against, then try again.
        this.planCooldown--;
        return Button.Back;
      }
      if (this.planBudget.left <= 0) return 0;
      this.planBudget.left--;
      const goal = this.pickGoal(pos);
      this.path = this.nav.findPath(pos, goal) ?? [];
      this.pathAge = 0;
      if (this.path.length === 0) {
        // Never retry every tick: that would also eat every other bot's planning budget.
        this.planCooldown = 30;
        return 0;
      }
    }
    let next = this.path[0]!;
    while (this.path.length > 1 && Math.hypot(next[0] - pos[0], next[2] - pos[2]) < 0.7) {
      this.path.shift();
      next = this.path[0]!;
    }
    if (this.path.length === 1 && Math.hypot(next[0] - pos[0], next[2] - pos[2]) < 0.7) {
      this.path = [];
      return 0;
    }
    this.turnTowards(Math.atan2(-(next[0] - pos[0]), -(next[2] - pos[2])), 0);

    // Stuck detection: no progress for 1 s → jump; for 2 s → new plan.
    const moved = Math.hypot(pos[0] - this.lastPos[0], pos[2] - this.lastPos[2]);
    this.lastPos = pos;
    this.stuckTicks = moved < 0.02 ? this.stuckTicks + 1 : 0;
    let buttons = Button.Forward | Button.Sprint;
    if (this.jumpCooldown > 0) this.jumpCooldown--;
    if (this.stuckTicks > TICK_RATE && this.jumpCooldown === 0) {
      buttons |= Button.Jump;
      this.jumpCooldown = TICK_RATE;
    }
    if (this.stuckTicks > 2 * TICK_RATE) {
      this.path = [];
      this.stuckTicks = 0;
    }
    return buttons;
  }
}

/** Re-plan a hunt path every 4 s. */
const HUNT_REPLAN_TICKS = 4 * TICK_RATE;

/** Where bots aim: upper torso. */
function aimPoint(p: SimPlayer): Vec3 {
  const m = p.sim.move;
  const h = capsuleHeight(movement, m.crouching);
  return [m.position[0], m.position[1] + SKIN + h * 0.65, m.position[2]];
}
