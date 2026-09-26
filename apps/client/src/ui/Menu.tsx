import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { lore, maps, modes, news } from '@sentinel/content';
import { accessOf, apiUrl, reportPlayer, sendFeedback } from '../profile.ts';
import { addFriend, friends, recentPlayers, removeFriend } from '../social.ts';
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
import { useStatus } from './Hud.tsx';
import { LoadoutPicker } from './Loadout.tsx';
import { primerDone, setPrimerDone } from '../primer.ts';
import { pickRegion, regions } from '../regions.ts';
import { platform } from '../platform.ts';

interface Props {
  settings: Settings;
  onSettings: (next: Settings) => void;
  /** DEPLOY (main menu) or RESUME (in a match). */
  onPlay: () => void;
  /** LEAVE MATCH (pause menu). */
  onLeave: () => void;
}

/** Playlists offered on the Play screen (content mode ids). */
const PLAYLISTS = ['team-deathmatch', 'domination'] as const;

type Screen = 'play' | 'loadout' | 'career' | 'squad' | 'intel' | 'comms' | 'settings';

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'play', label: 'Play' },
  { id: 'loadout', label: 'Loadout' },
  { id: 'career', label: 'Career' },
  { id: 'squad', label: 'Squad' },
  { id: 'intel', label: 'Intel' },
  { id: 'comms', label: 'Comms' },
  { id: 'settings', label: 'Settings' },
];

/**
 * The menu, as a game front end: a left rail of screens over the live 3D backdrop. On first
 * load it is the main menu (nothing joined until DEPLOY); during a match, Esc brings it back
 * as the pause menu (RESUME / LEAVE MATCH), and the match keeps running meanwhile.
 */
export function Menu(props: Props) {
  const status = useStatus();
  const [screen, setScreen] = useState<Screen>('play');
  const paused = status.inMatch;

  return (
    <div class={`menu${paused ? ' paused' : ''}`} data-testid="menu">
      <div class="menu-grain" />
      <header class="menu-top">
        <Wordmark />
        <PlayerChip />
      </header>

      <nav class="menu-rail" aria-label="Menu">
        {paused && <div class="rail-note">Paused · the match goes on</div>}
        {SCREENS.map((s, i) => (
          <button
            key={s.id}
            class={`rail-item${screen === s.id ? ' active' : ''}`}
            data-testid={`nav-${s.id}`}
            onClick={() => setScreen(s.id)}
          >
            <span class="rail-num">{String(i + 1).padStart(2, '0')}</span>
            {s.id === 'play' && paused ? 'Match' : s.label}
          </button>
        ))}
        <div class="rail-spacer" />
        <button class="deploy" data-testid="play" onClick={props.onPlay}>
          <span>{paused ? 'Resume' : 'Deploy'}</span>
          <small>
            {paused
              ? 'back to the fight'
              : status.backend === 'starting'
                ? 'loading…'
                : 'join a match'}
          </small>
        </button>
        {paused && (
          <button class="rail-leave" data-testid="leave" onClick={props.onLeave}>
            Leave match
          </button>
        )}
      </nav>

      <main class="menu-screen" key={screen}>
        {screen === 'play' && (
          <PlayScreen onGo={setScreen} settings={props.settings} onSettings={props.onSettings} />
        )}
        {screen === 'loadout' && (
          <Screen title="Loadout" kicker="Applies the next time you spawn">
            <LoadoutPicker
              choice={loadoutChoice(props.settings)}
              onChange={(choice) => props.onSettings({ ...props.settings, ...choice })}
              access={accessOf(status.profile)}
            />
          </Screen>
        )}
        {screen === 'career' && <CareerScreen />}
        {screen === 'squad' && <SquadScreen />}
        {screen === 'intel' && <IntelScreen />}
        {screen === 'comms' && <CommsScreen mode={props.settings.mode} />}
        {screen === 'settings' && (
          <SettingsScreen settings={props.settings} onSettings={props.onSettings} />
        )}
      </main>

      <footer class="menu-status">
        <span class="status-dot" data-state={status.net.state} />
        <span data-testid="net-status">{status.net.text}</span>
        <span class="sep">/</span>
        <span data-testid="render-backend">renderer: {status.backend}</span>
        <span class="sep">/</span>
        <span>{lore.season.name}</span>
      </footer>
    </div>
  );
}

function Wordmark() {
  return (
    <div class="wordmark" aria-label="Sentinel Strike">
      <span class="wm-mark" aria-hidden="true" />
      <span class="wm-text">
        Sentinel<b>Strike</b>
      </span>
    </div>
  );
}

/** Top-right: level, XP to next level. */
function PlayerChip() {
  const p = useStatus().profile;
  if (!p) return <div class="chip-player muted">offline profile</div>;
  const pct = p.xpForNext ? Math.round((100 * p.xpIntoLevel) / p.xpForNext) : 100;
  return (
    <div class="chip-player" data-testid="profile">
      <span class="chip-level">
        <small>Level</small> {p.level}
      </span>
      <span class="chip-xp">
        <span class="bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <small>
          {p.xpIntoLevel.toLocaleString()} / {p.xpForNext.toLocaleString()} XP
        </small>
      </span>
    </div>
  );
}

function Screen(props: { title: string; kicker?: string; children: ComponentChildren }) {
  return (
    <section class="screen">
      <div class="screen-head">
        <h2>{props.title}</h2>
        {props.kicker && <p>{props.kicker}</p>}
      </div>
      {props.children}
    </section>
  );
}

// --- Play ---------------------------------------------------------------------------------

function PlayScreen({
  onGo,
  settings,
  onSettings,
}: {
  onGo: (s: Screen) => void;
  settings: Settings;
  onSettings: (next: Settings) => void;
}) {
  const status = useStatus();
  const map = maps[status.mapId] ?? maps['relay-yard']!;
  const invited = new URLSearchParams(location.search).has('with');
  const m = status.match;
  const daily = status.profile?.challenges.filter((c) => c.period === 'daily') ?? [];
  const team = m ? lore.factions[m.myTeam] : undefined;
  const mode = modes[status.inMatch && m ? m.mode : settings.mode] ?? modes['team-deathmatch']!;
  return (
    <section class="screen play">
      <div class="mode">
        <div class="mode-tag">
          {status.inMatch ? (m ? `Match · ${m.phase}` : 'Joining…') : 'Quick play'}
        </div>
        <h1 class="mode-title">{mode.name}</h1>
        <div class="mode-meta">
          6 v 6 · first to {mode.scoreLimit} · {Math.round(mode.timeLimitSeconds / 60)} min
        </div>
        {!status.inMatch && (
          <div class="playlists" role="radiogroup" aria-label="Playlist">
            {PLAYLISTS.map((id) => {
              const def = modes[id]!;
              const on = settings.mode === id;
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={on}
                  class={`playlist${on ? ' on' : ''}`}
                  data-testid={`mode-${id}`}
                  onClick={() => onSettings({ ...settings, mode: id })}
                >
                  <b>{def.name}</b>
                  <span>{def.description}</span>
                </button>
              );
            })}
          </div>
        )}
        {!status.inMatch && !invited && (
          <RegionPicker settings={settings} onSettings={onSettings} />
        )}
        {invited && !status.inMatch && (
          <div class="notice">A friend invited you: DEPLOY puts you on their team.</div>
        )}
        {team && (
          <div class={`notice faction-${team.id}`}>
            You fight for the <b>{team.name}</b>. {team.motto}
          </div>
        )}
      </div>

      <div class="map-card">
        <div class="map-kicker">{status.inMatch ? 'Current site' : 'Next site'}</div>
        <div class="map-name">{map.name}</div>
        <div class="map-loc">{map.location}</div>
        <p>{map.description}</p>
      </div>

      <div class="play-cols">
        <div class="panel">
          <div class="panel-h">{lore.season.name}</div>
          <p>{lore.season.text}</p>
          <button class="link" onClick={() => onGo('intel')}>
            Read the briefing →
          </button>
        </div>
        <div class="panel">
          <div class="panel-h">Today's orders</div>
          {daily.length === 0 && <p class="muted">Orders arrive when your profile loads.</p>}
          {daily.map((c) => (
            <Order key={c.id} text={c.text} progress={c.progress} target={c.target} xp={c.xp} />
          ))}
          {daily.length > 0 && (
            <button class="link" onClick={() => onGo('career')}>
              All challenges →
            </button>
          )}
        </div>
      </div>
      <p class="controls-hint">
        WASD move · Mouse aim/fire · Shift sprint · C crouch/slide · G frag · Q smoke · Enter chat ·
        Esc pause
      </p>
    </section>
  );
}

/** Server region: Auto (lowest ping) or a fixed one; one region shows just its ping. */
function RegionPicker({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (next: Settings) => void;
}) {
  const pings = useStatus().regionPings;
  const list = regions();
  const measured = Object.keys(pings).length > 0;
  const ms = (id: string) => {
    if (!measured) return '…';
    const p = pings[id];
    return p == null ? 'offline' : `${p} ms`;
  };
  const choice = list.some((r) => r.id === settings.region) ? settings.region : 'auto';
  const best = pickRegion(list, pings, 'auto');
  if (list.length === 1) {
    return (
      <div class="regions single" data-testid="regions">
        Server <b>{ms(list[0]!.id)}</b>
      </div>
    );
  }
  const option = (id: string, label: string, ping: string) => (
    <button
      key={id}
      role="radio"
      aria-checked={choice === id}
      class={`region${choice === id ? ' on' : ''}`}
      data-testid={`region-${id}`}
      onClick={() => onSettings({ ...settings, region: id })}
    >
      {label} <small>{ping}</small>
    </button>
  );
  return (
    <div class="regions" role="radiogroup" aria-label="Server region" data-testid="regions">
      <span class="regions-h">Region</span>
      {option('auto', `Auto · ${best.name}`, ms(best.id))}
      {list.map((r) => option(r.id, r.name, ms(r.id)))}
    </div>
  );
}

function Order(props: { text: string; progress: number; target: number; xp: number }) {
  const done = props.progress >= props.target;
  return (
    <div class={`order${done ? ' done' : ''}`}>
      <div class="order-row">
        <span>{props.text}</span>
        <span>{done ? 'Done' : `${props.progress}/${props.target}`}</span>
      </div>
      <div class="bar">
        <span style={{ width: `${Math.round((100 * props.progress) / props.target)}%` }} />
      </div>
      <small>+{props.xp} XP</small>
    </div>
  );
}

// --- Career -------------------------------------------------------------------------------

function CareerScreen() {
  const p = useStatus().profile;
  return (
    <Screen title="Career" kicker="Progress counts only from server-reported matches">
      {!p && (
        <p class="muted">Your profile is offline (the progression service isn't reachable).</p>
      )}
      {p && (
        <div class="career">
          <div class="career-level">
            <div class="big-num">{p.level}</div>
            <div>
              <div class="panel-h">Level</div>
              <div class="bar wide">
                <span
                  style={{
                    width: `${p.xpForNext ? Math.round((100 * p.xpIntoLevel) / p.xpForNext) : 100}%`,
                  }}
                />
              </div>
              <small>
                {p.xp.toLocaleString()} XP total · {p.xpForNext - p.xpIntoLevel} to next level
              </small>
            </div>
          </div>
          <div class="stat-row">
            <Stat label="Matches" value={p.matches} />
            <Stat label="Wins" value={p.wins} />
            <Stat label="Eliminations" value={p.kills} />
            <Stat label="K/D" value={(p.kills / Math.max(1, p.deaths)).toFixed(2)} />
          </div>
          <div class="challenges" data-testid="challenges">
            {(['daily', 'weekly'] as const).map((period) => (
              <div class="panel" key={period}>
                <div class="panel-h">
                  {period === 'daily' ? 'Daily challenges' : 'Weekly challenges'}
                </div>
                {p.challenges
                  .filter((c) => c.period === period)
                  .map((c) => (
                    <Order
                      key={c.id}
                      text={c.text}
                      progress={c.progress}
                      target={c.target}
                      xp={c.xp}
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Screen>
  );
}

function Stat(props: { label: string; value: string | number }) {
  return (
    <div class="stat">
      <div class="stat-v">{props.value}</div>
      <div class="stat-l">{props.label}</div>
    </div>
  );
}

// --- Squad --------------------------------------------------------------------------------

interface PlayerCard {
  code: string;
  name: string;
  level: number;
  lastPlayed: number;
}

function SquadScreen() {
  const status = useStatus();
  const [recent, setRecent] = useState(recentPlayers());
  const [friendCodes, setFriendCodes] = useState(friends());
  const [cards, setCards] = useState<Record<string, PlayerCard>>({});
  const [copied, setCopied] = useState(false);

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
  return (
    <Screen title="Squad" kicker="Play with friends: they join your match, on your team">
      <div class="panel">
        <div class="panel-h">Invite link</div>
        {status.invite ? (
          <div class="field-row" data-testid="invite">
            <input type="text" readOnly value={status.invite} data-testid="invite-link" />
            <button
              class="btn"
              onClick={() =>
                void navigator.clipboard?.writeText(status.invite!).then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <p class="muted">Deploy first: the link brings friends into your match.</p>
        )}
      </div>
      <MatchPlayers />
      <div class="play-cols">
        <div class="panel">
          <div class="panel-h">Friends</div>
          {status.profile?.code && (
            <p class="muted">
              Your player code:{' '}
              <b class="mono" data-testid="my-code">
                {status.profile.code}
              </b>
            </p>
          )}
          {friendCodes.length === 0 && <p class="muted">No friends yet.</p>}
          {friendCodes.map((code) => {
            const c = cards[code];
            return (
              <div class="list-row" key={code} data-testid={`friend-${code}`}>
                <span>
                  {c ? c.name : <span class="mono">{code}</span>}
                  {c && (
                    <small>
                      level {c.level} · played {new Date(c.lastPlayed).toLocaleDateString()}
                    </small>
                  )}
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
          <FriendByCode onAdd={add} />
        </div>
        <div class="panel">
          <div class="panel-h">Recent players</div>
          {recent.length === 0 && <p class="muted">People you play with show up here.</p>}
          {recent.slice(0, 10).map((p) => (
            <div class="list-row" key={p.code}>
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
        </div>
      </div>
    </Screen>
  );
}

function FriendByCode({ onAdd }: { onAdd: (code: string) => void }) {
  const [code, setCode] = useState('');
  const valid = /^[0-9a-f]{16}$/.test(code);
  return (
    <div class="field-row">
      <input
        type="text"
        placeholder="Friend's player code"
        maxLength={16}
        value={code}
        data-testid="friend-code"
        onInput={(e) => setCode((e.target as HTMLInputElement).value.trim().toLowerCase())}
      />
      <button
        class="btn"
        disabled={!valid}
        onClick={() => {
          onAdd(code);
          setCode('');
        }}
      >
        Add
      </button>
    </div>
  );
}

// --- Intel (story) ------------------------------------------------------------------------

function IntelScreen() {
  const sites = ['relay-yard', 'saltline-depot'].map((id) => maps[id]!).filter(Boolean);
  return (
    <Screen title="Intel" kicker="Briefing · Saltline coast">
      <p class="lead">{lore.premise}</p>
      <div class="factions">
        {lore.factions.map((f) => (
          <div class={`faction faction-${f.id}`} key={f.id}>
            <div class="faction-name">{f.name}</div>
            <div class="faction-motto">“{f.motto}”</div>
            <p>{f.text}</p>
          </div>
        ))}
      </div>
      <div class="panel">
        <div class="panel-h">{lore.season.name}</div>
        <p>{lore.season.text}</p>
      </div>
      <div class="sites">
        {sites.map((m) => (
          <div class="site" key={m.id}>
            <div class="map-name small">{m.name}</div>
            <div class="map-loc">{m.location}</div>
            <p>{m.description}</p>
          </div>
        ))}
      </div>
    </Screen>
  );
}

function PrimerReset() {
  const [done, setDone] = useState(primerDone);
  return (
    <div class="row">
      <span>First-match tips</span>
      <button
        class="btn"
        disabled={!done}
        data-testid="primer-reset"
        onClick={() => {
          setPrimerDone(false);
          setDone(false);
        }}
      >
        {done ? 'Show again' : 'Next match'}
      </button>
    </div>
  );
}

// --- Comms: patch notes, feedback, community ----------------------------------------------

type FeedbackKind = 'bug' | 'idea' | 'other';

function CommsScreen({ mode }: { mode: string }) {
  const status = useStatus();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [latest, ...older] = news.patches;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (sending || text.trim().length < 3) return;
    setSending(true);
    const r = await sendFeedback(kind, text.trim(), {
      build: news.patches[0]!.version,
      renderer: status.backend,
      mode,
      userAgent: navigator.userAgent.slice(0, 300),
    });
    setSending(false);
    setResult(r);
    if (r.ok) setText('');
  };

  return (
    <Screen title="Comms" kicker={`Build ${latest!.version} · ${latest!.date}`}>
      <div class="play-cols">
        <div>
          <div class="panel patch" data-testid="patch-notes">
            <div class="panel-h">
              {latest!.version} — {latest!.title}
            </div>
            <ul>
              {latest!.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
          {older.map((p) => (
            <details class="panel patch" key={p.version}>
              <summary class="panel-h">
                {p.version} — {p.title} <small class="muted">{p.date}</small>
              </summary>
              <ul>
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
        <div>
          <form class="panel feedback" onSubmit={submit} data-testid="feedback">
            <div class="panel-h">Send feedback</div>
            <p>{news.community.feedbackNote}</p>
            <div class="tabs" role="radiogroup" aria-label="Kind">
              {(['bug', 'idea', 'other'] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  role="radio"
                  aria-checked={kind === k}
                  class={`tab${kind === k ? ' active' : ''}`}
                  data-testid={`feedback-${k}`}
                  onClick={() => setKind(k)}
                >
                  {k}
                </button>
              ))}
            </div>
            <textarea
              data-testid="feedback-text"
              maxLength={1000}
              rows={5}
              placeholder={
                kind === 'bug'
                  ? 'What happened, and what were you doing? (map, mode, weapon)'
                  : 'Tell us…'
              }
              value={text}
              onInput={(e) => {
                setText((e.target as HTMLTextAreaElement).value);
                setResult(null);
              }}
            />
            <div class="field-row">
              <small class="muted">
                {text.length}/1000 · sends your build and renderer, nothing personal
              </small>
              <button
                class="btn"
                type="submit"
                disabled={sending || text.trim().length < 3}
                data-testid="feedback-send"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
            {result && (
              <p class={result.ok ? 'ok' : 'warn'} data-testid="feedback-result" role="status">
                {result.message}
              </p>
            )}
          </form>
          <div class="panel">
            <div class="panel-h">Community</div>
            {news.community.discord && platform().externalLinks ? (
              <a
                class="btn"
                href={news.community.discord}
                target="_blank"
                rel="noopener noreferrer"
              >
                Join the Discord
              </a>
            ) : (
              <p class="muted">The community server opens with the public beta.</p>
            )}
          </div>
        </div>
      </div>
    </Screen>
  );
}

// --- Settings -----------------------------------------------------------------------------

function SettingsScreen({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (next: Settings) => void;
}) {
  const [tab, setTab] = useState<'game' | 'graphics' | 'controls'>('game');
  const [waitingFor, setWaitingFor] = useState<Action | null>(null);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onSettings({ ...settings, [key]: value });

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

  return (
    <Screen title="Settings">
      <div class="tabs">
        {(['game', 'graphics', 'controls'] as const).map((t) => (
          <button
            key={t}
            class={`tab${tab === t ? ' active' : ''}`}
            data-testid={`settings-${t}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'game' && (
        <div class="form">
          <label class="row">
            <span>Callsign</span>
            <input
              type="text"
              maxLength={16}
              placeholder="Player"
              value={settings.name}
              data-testid="name-input"
              onChange={(e) => set('name', (e.target as HTMLInputElement).value)}
            />
          </label>
          <p class="hint">Shown to other players from your next match.</p>
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
            <span>Field of view: {settings.fov}°</span>
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
          <PrimerReset />
        </div>
      )}

      {tab === 'graphics' && (
        <div class="form">
          <label class="row">
            <span>Quality</span>
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
          <p class="hint">Shadow quality changes after a reload; resolution right away.</p>
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
        </div>
      )}

      {tab === 'controls' && (
        <div class="form">
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
          <p class="hint">
            Mouse: left fire, right aim, wheel swap. Slide: sprint, then crouch. T: team chat. F3:
            network stats.{' '}
            <button class="link" onClick={() => onSettings(DEFAULT_SETTINGS)}>
              Reset to defaults
            </button>
          </p>
        </div>
      )}
    </Screen>
  );
}

/** The humans in this match: add as friend, or report to the moderators. */
function MatchPlayers() {
  const status = useStatus();
  const [note, setNote] = useState<Record<string, string>>({});
  const [friendCodes, setFriendCodes] = useState(friends());
  const others = (status.match?.players ?? []).filter((p) => !p.bot && !p.me && p.code);
  if (!status.inMatch) return null;
  return (
    <div class="panel" data-testid="match-players">
      <div class="panel-h">Players in this match</div>
      {others.length === 0 && <p class="muted">Only you and bots right now.</p>}
      {others.map((p) => (
        <div class="list-row" key={p.code}>
          <span>
            {p.name}
            <small>
              {note[p.code] ?? (p.team === status.match!.myTeam ? 'teammate' : 'enemy')}
            </small>
          </span>
          <span class="row-actions">
            {!friendCodes.includes(p.code) && (
              <button
                class="link"
                onClick={() => {
                  addFriend(p.code);
                  setFriendCodes(friends());
                }}
              >
                Add friend
              </button>
            )}
            {(['cheating', 'abuse', 'name'] as const).map((reason) => (
              <button
                key={reason}
                class="link danger"
                data-testid={`report-${reason}-${p.code}`}
                onClick={() =>
                  void reportPlayer(p.code, reason).then((msg) =>
                    setNote((n) => ({ ...n, [p.code]: msg })),
                  )
                }
              >
                Report {reason}
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
