import { useEffect, useState } from 'preact/hooks';
import { useStatus } from './Hud.tsx';
import { accessOf, apiUrl } from '../profile.ts';
import { addFriend, friends, recentPlayers, removeFriend } from '../social.ts';
import { LoadoutPicker } from './Loadout.tsx';
import {
  ACTIONS,
  ACTION_LABELS,
  DEFAULT_SETTINGS,
  LIMITS,
  keyLabel,
  loadoutChoice,
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
        <p class="menu-sub">
          Team Deathmatch · 6v6{useStatus().mapName ? ` · ${useStatus().mapName}` : ''}
        </p>
        <ProfileCard />
        <Challenges />
        <Invite />
        <Social />
        <button class="play" data-testid="play" onClick={onPlay}>
          Click to play
        </button>
        <p class="menu-hint">Esc releases the mouse and brings this menu back.</p>

        <h2>Loadout</h2>
        <LoadoutPicker
          choice={loadoutChoice(settings)}
          onChange={(choice) => onSettings({ ...settings, ...choice })}
          access={accessOf(useStatus().profile)}
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
          <span>Graphics</span>
          <select
            value={settings.graphics}
            data-testid="graphics"
            onChange={(e) =>
              set('graphics', (e.target as HTMLSelectElement).value as Settings['graphics'])
            }
          >
            <option value="low">Low (fastest, no shadows)</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <p class="menu-hint">Shadow quality changes after a page reload; resolution right away.</p>
        <label class="row">
          <span>Render scale: {Math.round(settings.renderScale * 100)}%</span>
          <input
            type="range"
            min={LIMITS.renderScale.min}
            max={LIMITS.renderScale.max}
            step="0.05"
            value={settings.renderScale}
            onInput={(e) => set('renderScale', Number((e.target as HTMLInputElement).value))}
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

/** Today's and this week's challenges (progress comes from the server's match reports). */
function Challenges() {
  const list = useStatus().profile?.challenges;
  if (!list?.length) return null;
  return (
    <div class="challenges" data-testid="challenges">
      {(['daily', 'weekly'] as const).map((period) => (
        <div key={period}>
          <div class="challenges-h">{period === 'daily' ? 'Daily' : 'Weekly'} challenges</div>
          {list
            .filter((c) => c.period === period)
            .map((c) => {
              const done = c.progress >= c.target;
              return (
                <div class={`challenge${done ? ' done' : ''}`} key={c.id}>
                  <div class="challenge-row">
                    <span>{c.text}</span>
                    <span>
                      {done ? 'Done' : `${c.progress}/${c.target}`} · +{c.xp} XP
                    </span>
                  </div>
                  <div class="xp-bar">
                    <div
                      class="xp-fill"
                      style={{ width: `${Math.round((100 * c.progress) / c.target)}%` }}
                    />
                  </div>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

/** Party invite: a link that puts friends into this match on your team. */
function Invite() {
  const link = useStatus().invite;
  const [copied, setCopied] = useState(false);
  if (!link) return null;
  return (
    <div class="invite" data-testid="invite">
      <span>Play with friends: send them this link (they join your team).</span>
      <div class="invite-row">
        <input type="text" readOnly value={link} data-testid="invite-link" />
        <button
          class="key"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}

interface PlayerCard {
  code: string;
  name: string;
  level: number;
  lastPlayed: number;
}

/** Recent players (this browser) and friends (by player code, looked up in the API). */
function Social() {
  const [recent, setRecent] = useState(recentPlayers());
  const [friendCodes, setFriendCodes] = useState(friends());
  const [cards, setCards] = useState<Record<string, PlayerCard>>({});
  const myCode = useStatus().profile?.code;

  useEffect(() => {
    setRecent(recentPlayers());
    for (const code of friendCodes) {
      if (cards[code]) continue;
      void fetch(`${apiUrl()}/players/${code}`)
        .then((r) => (r.ok ? (r.json() as Promise<PlayerCard>) : null))
        .then((c) => c && setCards((all) => ({ ...all, [code]: c })))
        .catch(() => undefined);
    }
  }, [friendCodes]);

  const add = (code: string) => {
    addFriend(code);
    setFriendCodes(friends());
  };
  if (!recent.length && !friendCodes.length && !myCode) return null;
  return (
    <div class="social" data-testid="social">
      {myCode && (
        <p class="menu-hint">
          Your player code: <b data-testid="my-code">{myCode}</b>
        </p>
      )}
      {friendCodes.length > 0 && (
        <>
          <div class="challenges-h">Friends</div>
          {friendCodes.map((code) => {
            const c = cards[code];
            return (
              <div class="social-row" key={code} data-testid={`friend-${code}`}>
                <span>
                  {c ? `${c.name} · level ${c.level}` : code}
                  {c && <small> · last played {new Date(c.lastPlayed).toLocaleDateString()}</small>}
                </span>
                <button
                  class="link"
                  onClick={() => {
                    removeFriend(code);
                    setFriendCodes(friends());
                  }}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </>
      )}
      {recent.length > 0 && (
        <>
          <div class="challenges-h">Recent players</div>
          {recent.slice(0, 8).map((p) => (
            <div class="social-row" key={p.code}>
              <span>{p.name}</span>
              {friendCodes.includes(p.code) ? (
                <small>Friend</small>
              ) : (
                <button
                  class="link"
                  data-testid={`add-friend-${p.code}`}
                  onClick={() => add(p.code)}
                >
                  Add friend
                </button>
              )}
            </div>
          ))}
        </>
      )}
      <FriendByCode onAdd={add} />
    </div>
  );
}

function FriendByCode({ onAdd }: { onAdd: (code: string) => void }) {
  const [code, setCode] = useState('');
  const valid = /^[0-9a-f]{10}$/.test(code);
  return (
    <div class="invite-row">
      <input
        type="text"
        placeholder="Friend's player code"
        maxLength={10}
        value={code}
        data-testid="friend-code"
        onInput={(e) => setCode((e.target as HTMLInputElement).value.trim().toLowerCase())}
      />
      <button
        class="key"
        disabled={!valid}
        onClick={() => {
          onAdd(code);
          setCode('');
        }}
      >
        Add friend
      </button>
    </div>
  );
}
