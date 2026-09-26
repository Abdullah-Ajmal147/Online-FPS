import { useEffect, useState } from 'preact/hooks';
import type { MatchHud } from '../store.ts';
import { useStatus } from './Hud.tsx';

const TEAM_NAMES = ['Aegis Directive', 'Ember Syndicate'];
const TEAM_CLASS = ['team-a', 'team-b'];

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Top-centre score bar, phase banners, Tab scoreboard and the end-of-match screen. */
export function MatchUi() {
  const m = useStatus().match;
  const [tab, setTab] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setTab(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Tab' && setTab(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  if (!m) return null;
  return (
    <>
      <ScoreBar m={m} />
      {m.phase === 'warmup' && (
        <Banner title="Warm-up" sub={`Match starts in ${Math.ceil(m.secondsLeft)} s`} />
      )}
      {m.phase === 'countdown' && (
        <Banner
          title={String(Math.max(1, Math.ceil(m.secondsLeft)))}
          sub={m.mode === 'domination' ? 'Domination' : 'Team Deathmatch'}
          big
        />
      )}
      {m.phase === 'ended' ? <Results m={m} /> : tab && <Scoreboard m={m} />}
    </>
  );
}

function ScoreBar({ m }: { m: MatchHud }) {
  const enemy = 1 - m.myTeam;
  return (
    <div class="scorebar" data-testid="scorebar">
      <span class={`sb-score ${TEAM_CLASS[m.myTeam]}`}>{m.scores[0]}</span>
      <span class="sb-clock">
        {m.phase === 'live' ? clock(m.secondsLeft) : m.phase === 'warmup' ? 'WARM-UP' : '—'}
      </span>
      <span class={`sb-score ${TEAM_CLASS[enemy]}`}>{m.scores[1]}</span>
      <div class="sb-limit">
        first to {m.scoreLimit}
        {m.private && (
          <span class="private-tag" data-testid="private-tag">
            PRIVATE
          </span>
        )}
      </div>
      {m.points.length > 0 && <Points m={m} />}
    </div>
  );
}

/** Domination: A B C in the colour of the faction holding them, with the capture meter. */
function Points({ m }: { m: MatchHud }) {
  return (
    <div class="points" data-testid="points">
      {m.points.map((p) => (
        <span
          class={`point ${p.owner < 0 ? 'neutral' : `held-${p.owner}`}`}
          key={p.id}
          title={
            p.owner < 0
              ? `${p.id}: neutral`
              : p.owner === m.myTeam
                ? `${p.id}: ours`
                : `${p.id}: theirs`
          }
        >
          {p.id}
          <span
            class={`point-meter toward-${p.control >= 0 ? 0 : 1}`}
            style={{ width: `${Math.round(Math.abs(p.control) * 100)}%` }}
          />
        </span>
      ))}
    </div>
  );
}

function Banner({ title, sub, big = false }: { title: string; sub: string; big?: boolean }) {
  return (
    <div class={`banner ${big ? 'banner-big' : ''}`}>
      <div class="banner-title">{title}</div>
      <div class="banner-sub">{sub}</div>
    </div>
  );
}

function Table({ m }: { m: MatchHud }) {
  const teams = [m.myTeam, 1 - m.myTeam];
  return (
    <div class="sb-teams">
      {teams.map((team, i) => (
        <div class="sb-team" key={team}>
          <div class={`sb-team-name ${TEAM_CLASS[team]}`}>
            {TEAM_NAMES[team]} <span>{m.scores[i]}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>K</th>
                <th>D</th>
              </tr>
            </thead>
            <tbody>
              {m.players
                .filter((p) => p.team === team)
                .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
                .map((p) => (
                  <tr key={p.id} class={p.me ? 'sb-me' : ''}>
                    <td>
                      {p.name}
                      {p.bot ? <span class="sb-bot">BOT</span> : null}
                    </td>
                    <td>{p.kills}</td>
                    <td>{p.deaths}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Scoreboard({ m }: { m: MatchHud }) {
  return (
    <div class="scoreboard" data-testid="scoreboard">
      <Table m={m} />
    </div>
  );
}

function Results({ m }: { m: MatchHud }) {
  const title = m.result === 'win' ? 'Victory' : m.result === 'loss' ? 'Defeat' : 'Draw';
  return (
    <div class="results" data-testid="results">
      <div class={`results-title results-${m.result}`}>{title}</div>
      <div class="results-score">
        {m.scores[0]} – {m.scores[1]}
      </div>
      {m.mvp && <div class="results-mvp">MVP: {m.mvp}</div>}
      {m.private && m.players.filter((p) => !p.bot).length < 4 ? (
        <div class="xp-panel xp-pending" data-testid="private-no-xp">
          Private match: XP counts with 4 or more real players.
        </div>
      ) : (
        <XpPanel />
      )}
      <Table m={m} />
      <div class="results-next">Next match in {Math.ceil(m.secondsLeft)} s</div>
    </div>
  );
}

/** This match's XP, line by line, from the API (appears a moment after the match ends). */
function XpPanel() {
  const { profile, xpBaseline } = useStatus();
  const last = profile?.lastMatch;
  if (!last || last.matchId === xpBaseline) {
    return <div class="xp-panel xp-pending">Counting XP…</div>;
  }
  return (
    <div class="xp-panel" data-testid="xp-panel">
      {last.lines.map((l) => (
        <div class="xp-line" key={l.label}>
          <span>{l.label}</span>
          <span>+{l.xp}</span>
        </div>
      ))}
      {last.challenges.map((c) => (
        <div class="xp-line xp-challenge" key={c.text}>
          <span>Challenge: {c.text}</span>
          <span>+{c.xp}</span>
        </div>
      ))}
      <div class="xp-line xp-total">
        <span>Total</span>
        <span>+{last.total} XP</span>
      </div>
      {last.levelAfter > last.levelBefore && (
        <div class="level-up" data-testid="level-up">
          Level up! Level {last.levelAfter}
        </div>
      )}
    </div>
  );
}
