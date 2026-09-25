import { Button, createRng, type PlayerInput } from '@sentinel/shared';

/**
 * Phase 1 bot: wanders the map. Picks a heading, sprints or walks for a while, sometimes jumps,
 * crouches or strafes, and turns away after a while (it will also turn when it runs into walls,
 * because a stuck bot changes plan on its next decision).
 */
export class WanderBrain {
  private yaw: number;
  private turnRate = 0;
  private buttons = Button.Forward;
  private ticksLeft = 0;
  private tick = 0;
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = createRng(seed);
    this.yaw = Math.floor(this.random() * 65536);
  }

  next(): PlayerInput {
    this.tick++;
    if (this.ticksLeft-- <= 0) this.decide();
    this.yaw = (this.yaw + this.turnRate + 65536) & 0xffff;
    let buttons = this.buttons;
    // Tap jump now and then (press, not hold, so it actually jumps).
    if (this.tick % 97 === 0 && this.random() < 0.5) buttons |= Button.Jump;
    return { buttons, yaw: this.yaw, pitch: 0 };
  }

  private decide(): void {
    const r = this.random();
    this.ticksLeft = 60 + Math.floor(this.random() * 180);
    this.turnRate = Math.floor((this.random() - 0.5) * 400);
    if (r < 0.5) this.buttons = Button.Forward | Button.Sprint;
    else if (r < 0.75) this.buttons = Button.Forward;
    else if (r < 0.85) this.buttons = Button.Forward | Button.Crouch;
    else if (r < 0.95) this.buttons = this.random() < 0.5 ? Button.Left : Button.Right;
    else this.buttons = 0;
    if (this.random() < 0.3) this.yaw = Math.floor(this.random() * 65536);
  }
}
