import { useEffect, useState } from 'preact/hooks';
import { useStatus } from './Hud.tsx';
import { LoadoutPicker } from './Loadout.tsx';
import {
  ACTIONS,
  ACTION_LABELS,
  DEFAULT_SETTINGS,
  LIMITS,
  keyLabel,
  rebind,
  type Action,
  type Settings,
} from '../settings.ts';

interface Props {
  settings: Settings;
  onSettings: (next: Settings) => void;
  onPlay: () => void;
}

/** Shown whenever the mouse is not captured: start screen, controls and settings. */
export function Menu({ settings, onSettings, onPlay }: Props) {
  const [waitingFor, setWaitingFor] = useState<Action | null>(null);

  useEffect(() => {
    if (!waitingFor) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        onSettings({ ...settings, bindings: rebind(settings.bindings, waitingFor, e.code) });
      }
      setWaitingFor(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [waitingFor, settings, onSettings]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onSettings({ ...settings, [key]: value });

  return (
    <div class="menu" data-testid="menu">
      <div class="menu-card">
        <h1>Sentinel Strike</h1>
        <p class="menu-sub">Team Deathmatch · 6v6 · Relay Yard</p>
        <ProfileCard />
        <button class="play" data-testid="play" onClick={onPlay}>
          Click to play
        </button>
        <p class="menu-hint">Esc releases the mouse and brings this menu back.</p>

        <h2>Loadout</h2>
        <LoadoutPicker
          primary={settings.primary}
          secondary={settings.secondary}
          onChange={(primary, secondary) => onSettings({ ...settings, primary, secondary })}
        />

        <label class="row">
          <span>Your name</span>
          <input
            type="text"
            maxLength={16}
            placeholder="Player"
            value={settings.name}
            data-testid="name-input"
            onChange={(e) => set('name', (e.target as HTMLInputElement).value)}
          />
        </label>
        <p class="menu-hint">Takes effect next time you join a match.</p>

        <h2>Settings</h2>
        <label class="row">
          <span>Mouse sensitivity (°/count)</span>
          <input
            type="number"
            step="0.005"
            min={LIMITS.sensitivity.min}
            max={LIMITS.sensitivity.max}
            value={settings.sensitivity}
            onChange={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) {
                set(
                  'sensitivity',
                  Math.min(LIMITS.sensitivity.max, Math.max(LIMITS.sensitivity.min, v)),
                );
              }
            }}
          />
        </label>
        <label class="row">
          <span>Field of view (horizontal): {settings.fov}°</span>
          <input
            type="range"
            min={LIMITS.fov.min}
            max={LIMITS.fov.max}
            value={settings.fov}
            onInput={(e) => set('fov', Number((e.target as HTMLInputElement).value))}
          />
        </label>
        <label class="row">
          <span>Toggle sprint (instead of hold)</span>
          <input
            type="checkbox"
            checked={settings.toggleSprint}
            onChange={(e) => set('toggleSprint', (e.target as HTMLInputElement).checked)}
          />
        </label>
        <label class="row">
          <span>Head bob</span>
          <input
            type="checkbox"
            checked={settings.headBob}
            onChange={(e) => set('headBob', (e.target as HTMLInputElement).checked)}
          />
        </label>

        <h2>Controls</h2>
        <div class="bindings">
          {ACTIONS.map((action) => (
            <div class="row" key={action}>
              <span>{ACTION_LABELS[action]}</span>
              <button class="key" onClick={() => setWaitingFor(action)}>
                {waitingFor === action ? 'press a key…' : keyLabel(settings.bindings[action])}
              </button>
            </div>
          ))}
        </div>
        <p class="menu-hint">
          Mouse: left fire, right aim, wheel swap. Slide: sprint, then crouch. F3: network stats.
          <button class="link" onClick={() => onSettings(DEFAULT_SETTINGS)}>
            Reset to defaults
          </button>
        </p>
      </div>
    </div>
  );
}

/** Level, XP bar and totals for this guest (hidden if the API is unreachable). */
function ProfileCard() {
  const p = useStatus().profile;
  if (!p) return null;
  const pct = p.xpForNext ? Math.round((100 * p.xpIntoLevel) / p.xpForNext) : 100;
  return (
    <div class="profile-card" data-testid="profile">
      <div class="profile-level">
        <span class="profile-level-label">
          Level <b>{p.level}</b>
        </span>
        <span>{p.xp.toLocaleString()} XP</span>
      </div>
      <div class="xp-bar">
        <div class="xp-fill" style={{ width: `${pct}%` }} />
      </div>
      <div class="profile-stats">
        {p.matches} matches · {p.wins} wins · {p.kills} kills
      </div>
    </div>
  );
}
