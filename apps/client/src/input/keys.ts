import { Button } from '@sentinel/shared';
import type { Action } from '../settings.ts';

/** Actions that are held buttons in the InputCmd bitfield (weapon keys pick a slot instead). */
const ACTION_BUTTON: Partial<Record<Action, number>> = {
  forward: Button.Forward,
  back: Button.Back,
  left: Button.Left,
  right: Button.Right,
  jump: Button.Jump,
  crouch: Button.Crouch,
  sprint: Button.Sprint,
  reload: Button.Reload,
  lethal: Button.Lethal,
  tactical: Button.Tactical,
};

/**
 * Turn the set of held keys into the InputCmd button bitfield.
 * With toggle sprint, the sprint key flips `sprintLatched` (tracked by the caller) and the
 * simulation still just sees a held Sprint bit.
 */
export function buttonsFromKeys(
  held: ReadonlySet<string>,
  bindings: Record<Action, string>,
  sprintLatched: boolean,
): number {
  let buttons = 0;
  for (const action of Object.keys(ACTION_BUTTON) as Action[]) {
    if (action === 'sprint') continue;
    if (held.has(bindings[action])) buttons |= ACTION_BUTTON[action]!;
  }
  if (sprintLatched) buttons |= Button.Sprint;
  return buttons;
}

/** Key turning speed, degrees per second (arrow keys by default). */
export const KEY_TURN_DEG_PER_SEC = 180;

/**
 * Yaw change in radians from the turn keys over `dt` seconds (left turns left, i.e. yaw grows).
 * A backup for mouse look: laptops often switch the touchpad off while keys are held
 * ("disable while typing"), which stops a touchpad from turning while running.
 */
export function keyTurn(
  held: ReadonlySet<string>,
  bindings: Record<Action, string>,
  dt: number,
): number {
  const dir = (held.has(bindings.turnLeft) ? 1 : 0) - (held.has(bindings.turnRight) ? 1 : 0);
  return (dir * KEY_TURN_DEG_PER_SEC * Math.PI * dt) / 180;
}
