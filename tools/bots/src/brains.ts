import { movement } from '@sentinel/content';
import type { GameEvent } from '@sentinel/protocol';
import {
  Button,
  SKIN,
  capsuleHeight,
  createRng,
  currentSpread,
  directionFromAngles,
  eyePosition,
  rayPlayer,
  type PlayerInput,
  type RemotePose,
  type ShotRequest,
  type Vec3,
} from '@sentinel/shared';
import type { Brain, BotView } from './bot.ts';

export { WanderBrain } from './brain.ts';

const TWO_PI = Math.PI * 2;
const toYaw = (rad: number) => ((Math.round((rad / TWO_PI) * 65536) % 65536) + 65536) % 65536;
const toPitch = (rad: number) =>
  Math.max(-16000, Math.min(16000, Math.round((rad / (Math.PI / 2)) * 16384)));

function nearestEnemy(view: BotView): [number, RemotePose] | null {
  let best: [number, RemotePose] | null = null;
  let bestD = Infinity;
  const me = view.self.move.position;
  for (const [id, pose] of view.others) {
    if (pose.team === view.team || !pose.alive) continue;
    const d = Math.hypot(pose.position[0] - me[0], pose.position[2] - me[2]);
    if (d < bestD) {
      bestD = d;
      best = [id, pose];
    }
  }
  return best;
}

/** Yaw that faces from `from` towards `to` (yaw 0 faces -Z). */
function yawTowards(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
}

/**
 * Phase 2 test target: walks to ~15 m from the nearest enemy, then strafes left/right,
 * changing direction every 0.5–1.5 s so a shooter has to track a moving target.
 */
export class StrafeBrain implements Brain {
  private dirTicks = 0;
  private left = true;
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = createRng(seed);
  }

  next(view: BotView): PlayerInput {
    const enemy = nearestEnemy(view);
    if (!enemy) return { buttons: 0, yaw: 0, pitch: 0 };
    const me = view.self.move.position;
    const yaw = toYaw(yawTowards(me, enemy[1].position));
    const dist = Math.hypot(enemy[1].position[0] - me[0], enemy[1].position[2] - me[2]);
    if (dist > 17) return { buttons: Button.Forward | Button.Sprint, yaw, pitch: 0 };
    if (--this.dirTicks <= 0) {
      this.left = !this.left;
      this.dirTicks = 30 + Math.floor(this.random() * 60);
    }
    return { buttons: this.left ? Button.Left : Button.Right, yaw, pitch: 0 };
  }
}

export interface AimStats {
  onTarget: number;
  registered: number;
}

/**
 * Phase 2 shooter: stands still, aims exactly at the nearest enemy's torso as this client draws
 * it (interpolated), compensates its own recoil, and fires with sights up. Each shot is checked
 * client-side — does the ray hit the target's hitbox as drawn, with no wall in between? — and
 * compared with the server's hit confirmations.
 */
export class AimBrain implements Brain {
  readonly stats: AimStats = { onTarget: 0, registered: 0 };
  private targetId: number | null = null;
  private ticks = 0;

  next(view: BotView): PlayerInput {
    this.ticks++;
    const enemy = nearestEnemy(view);
    if (!enemy || !view.alive) return { buttons: Button.Aim, yaw: 0, pitch: 0 };
    this.targetId = enemy[0];
    const w = view.self.weapon;
    const eye = eyePosition(view.self.move, view.ctx.movement);
    const t = torsoCenter(enemy[1]);
    const yawRad = yawTowards(eye, t);
    const pitchRad = Math.atan2(t[1] - eye[1], Math.hypot(t[0] - eye[0], t[2] - eye[2]));
    // Aim = view + recoil, so subtract our (predicted) recoil to land on target.
    const yaw = (toYaw(yawRad) - w.recoilYaw + 65536) & 0xffff;
    const pitch = toPitch(pitchRad) - w.recoilPitch;
    const spec = view.ctx.loadout[w.slot];
    // Controlled bursts: fire only once sights are fully up and spread has settled back to
    // near the ADS base, so the test measures hit registration rather than random spread.
    const settled =
      currentSpread(w, spec, { moving: false, airborne: false, sprinting: false }) <=
      spec.spread.ads + 10;
    // Wait out the target's 1.5 s spawn protection (protected players take no damage, so
    // shots at them would look like registration failures).
    const fire = w.adsTicks >= spec.adsTicks && settled && this.ticks > 2.5 * 60;
    return { buttons: Button.Aim | (fire ? Button.Fire : 0), yaw, pitch, weaponSlot: 0 };
  }

  onShot(shot: ShotRequest, view: BotView): void {
    if (this.targetId === null) return;
    const target = view.others.get(this.targetId);
    if (!target || !target.alive) return;
    const eye = eyePosition(view.self.move, view.ctx.movement);
    const dir = directionFromAngles(shot.yaw, shot.pitch);
    const range = view.ctx.loadout[shot.slot].def.maxRange;
    const hit = rayPlayer(eye, dir, target.position, target.crouching, movement, range);
    if (process.env.BOT_DEBUG) {
      const t = torsoCenter(target);
      const want = [t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]];
      const n = Math.hypot(...want);
      console.log(
        `[aim] dist ${n.toFixed(1)} dir ${dir.map((v) => v.toFixed(3))} want ${want.map((v) => (v / n).toFixed(3))} hit ${hit ? hit.zone : 'none'} eye ${eye.map((v) => v.toFixed(2))} tgt ${target.position.map((v) => v.toFixed(2))}`,
      );
    }
    if (!hit) return;
    // A wall in between? Then it isn't a fair on-target shot.
    const rapier = view.ctx.movement.rapier;
    const wall = view.ctx.movement.world.castRay(
      new rapier.Ray({ x: eye[0], y: eye[1], z: eye[2] }, { x: dir[0], y: dir[1], z: dir[2] }),
      hit.distance,
      true,
      rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    if (wall) return;
    this.stats.onTarget++;
  }

  onEvents(events: GameEvent[]): void {
    for (const e of events) if (e.type === 'hit') this.stats.registered++;
  }
}

function torsoCenter(pose: RemotePose): Vec3 {
  const h = capsuleHeight(movement, pose.crouching);
  return [pose.position[0], pose.position[1] + SKIN + h * 0.61, pose.position[2]];
}
