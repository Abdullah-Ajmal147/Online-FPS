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
