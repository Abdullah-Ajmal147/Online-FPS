import { resolveLoadout } from '@sentinel/content';

/** Player settings. Stored per browser (a convenience, not game state). */

export const ACTIONS = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'crouch',
  'sprint',
  'reload',
  'lethal',
  'tactical',
  'primary',
  'secondary',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Move left',
  right: 'Move right',
  jump: 'Jump',
  crouch: 'Crouch / slide',
  sprint: 'Sprint',
  reload: 'Reload',
  lethal: 'Frag grenade',
  tactical: 'Smoke grenade',
  primary: 'Primary weapon',
  secondary: 'Sidearm',
};

export const GRAPHICS_PRESETS = ['low', 'medium', 'high'] as const;
export type GraphicsPreset = (typeof GRAPHICS_PRESETS)[number];

export interface Settings {
  /** Display name (the server sanitizes it; accounts come in Phase 4). */
  name: string;
  /** Degrees of view rotation per mouse count (raw pointer-lock movement unit). */
  sensitivity: number;
  /** Horizontal field of view in degrees. */
  fov: number;
  toggleSprint: boolean;
  headBob: boolean;
  /** KeyboardEvent.code per action. */
  bindings: Record<Action, string>;
  /** Graphics preset: low = no shadows, 1× pixels (integrated GPUs); high = sharp shadows. */
  graphics: GraphicsPreset;
  /** Fraction of the screen resolution rendered (0.5–1): lower is faster, blurrier. */
  renderScale: number;
  /** Loadout weapon ids (applied at the next spawn). */
  primary: string;
  secondary: string;
}

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  sensitivity: 0.06,
  fov: 90,
  toggleSprint: false,
  headBob: false,
  graphics: 'medium',
  renderScale: 1,
  primary: 'kestrel-ar',
  secondary: 'wren-sp',
  // Crouch is C, not Ctrl: Ctrl+W closes the browser tab.
  bindings: {
    forward: 'KeyW',
    back: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    jump: 'Space',
    crouch: 'KeyC',
    sprint: 'ShiftLeft',
    reload: 'KeyR',
    lethal: 'KeyG',
    tactical: 'KeyQ',
    primary: 'Digit1',
    secondary: 'Digit2',
  },
};

export const LIMITS = {
  sensitivity: { min: 0.005, max: 0.5 },
  fov: { min: 70, max: 120 },
  renderScale: { min: 0.5, max: 1 },
} as const;

const STORAGE_KEY = 'sentinel.settings.v1';

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Merge anything stored with the defaults, so old or broken data never crashes the game. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  const bindings = { ...DEFAULT_SETTINGS.bindings };
  if (r.bindings && typeof r.bindings === 'object') {
    for (const action of ACTIONS) {
      const code = (r.bindings as Record<string, unknown>)[action];
      if (typeof code === 'string' && code.length > 0) bindings[action] = code;
    }
  }
  const { sensitivity, fov } = LIMITS;
  const [primary, secondary] = resolveLoadout(r.primary, r.secondary);
  return {
    graphics: GRAPHICS_PRESETS.includes(r.graphics as GraphicsPreset)
      ? (r.graphics as GraphicsPreset)
      : DEFAULT_SETTINGS.graphics,
    renderScale: clamp(
      r.renderScale,
      LIMITS.renderScale.min,
      LIMITS.renderScale.max,
      DEFAULT_SETTINGS.renderScale,
    ),
    primary: primary.id,
    secondary: secondary.id,
    sensitivity: clamp(
      r.sensitivity,
      sensitivity.min,
      sensitivity.max,
      DEFAULT_SETTINGS.sensitivity,
    ),
    fov: clamp(r.fov, fov.min, fov.max, DEFAULT_SETTINGS.fov),
    name: typeof r.name === 'string' ? r.name.slice(0, 16) : DEFAULT_SETTINGS.name,
    toggleSprint:
      typeof r.toggleSprint === 'boolean' ? r.toggleSprint : DEFAULT_SETTINGS.toggleSprint,
    headBob: typeof r.headBob === 'boolean' ? r.headBob : DEFAULT_SETTINGS.headBob,
    bindings,
  };
}

export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return normalizeSettings(text ? JSON.parse(text) : null);
  } catch {
    return normalizeSettings(null);
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: settings just won't persist.
  }
}

/** Rebind an action; a key used by another action is swapped so nothing is left unbound. */
export function rebind(
  bindings: Record<Action, string>,
  action: Action,
  code: string,
): Record<Action, string> {
  const next = { ...bindings };
  const other = ACTIONS.find((a) => a !== action && next[a] === code);
  if (other) next[other] = next[action];
  next[action] = code;
  return next;
}

/** "KeyW" → "W", "ShiftLeft" → "Left Shift". */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const m = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (m) return `${m[2]} ${m[1] === 'Control' ? 'Ctrl' : m[1]}`;
  return code;
}
