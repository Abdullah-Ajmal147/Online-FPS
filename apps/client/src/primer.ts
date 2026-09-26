import { modes } from '@sentinel/content';
import { keyLabel, type Settings } from './settings.ts';

/**
 * First-match primer (Phase 8 onboarding): a few one-line steps, each done by doing it.
 * Pure logic here; the UI (ui/Primer.tsx) feeds it input events.
 */
export interface PrimerStep {
  id: string;
  text: string;
  /** Key codes that complete the step (KeyboardEvent.code). */
  keys?: string[];
  /** Mouse buttons that complete the step (0 = left, 2 = right). */
  mouse?: number[];
  /** Completes by itself after this many seconds (steps that are read, not done). */
  seconds?: number;
}

export function primerSteps(s: Pick<Settings, 'bindings' | 'mode'>): PrimerStep[] {
  const b = s.bindings;
  const k = keyLabel;
  const mode = modes[s.mode] ?? modes['team-deathmatch']!;
  return [
    {
      id: 'move',
      text: `Move with ${k(b.forward)} ${k(b.left)} ${k(b.back)} ${k(b.right)} · ${k(b.sprint)} to sprint`,
      keys: [b.forward, b.back, b.left, b.right],
    },
    { id: 'shoot', text: 'Aim with the mouse · left click to fire', mouse: [0] },
    { id: 'ads', text: 'Hold right click to aim down sights', mouse: [2] },
    { id: 'reload', text: `${k(b.reload)} to reload`, keys: [b.reload] },
    {
      id: 'grenades',
      text: `${k(b.lethal)} throws a frag · ${k(b.tactical)} throws smoke`,
      keys: [b.lethal, b.tactical],
    },
    {
      id: 'objective',
      text: mode.capture
        ? 'Stand on nodes A, B and C to capture them. Held nodes score every second.'
        : `First team to ${mode.scoreLimit} kills wins. Tab shows the scoreboard.`,
      seconds: 7,
    },
  ];
}

export type PrimerEvent = { key: string } | { mouse: number } | { elapsed: number };

/** True if the event completes the step (elapsed = seconds the step has been shown). */
export function completes(step: PrimerStep, e: PrimerEvent): boolean {
  if ('key' in e) return !!step.keys?.includes(e.key);
  if ('mouse' in e) return !!step.mouse?.includes(e.mouse);
  return step.seconds !== undefined && e.elapsed >= step.seconds;
}

const STORAGE_KEY = 'sentinel.primer.v1';

/** Cached: the HUD asks every frame. */
let cached: boolean | null = null;

/** Whether the player has finished (or skipped) the primer; storage errors count as done. */
export function primerDone(): boolean {
  if (cached === null) {
    try {
      cached = localStorage.getItem(STORAGE_KEY) === 'done';
    } catch {
      cached = true;
    }
  }
  return cached;
}

export function setPrimerDone(done: boolean): void {
  cached = done;
  try {
    if (done) localStorage.setItem(STORAGE_KEY, 'done');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: the primer simply shows again next time.
  }
}
