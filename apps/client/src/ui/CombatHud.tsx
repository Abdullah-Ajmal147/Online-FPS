import { useEffect, useState } from 'preact/hooks';
import type { CombatHud as CombatHudState } from '../store.ts';
import { useStatus } from './Hud.tsx';

const TEAM_CLASS = ['team-a', 'team-b'];

/** Re-render a few times a second so timed things (hit marker, damage arcs) fade out. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(performance.now()), 50);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function CombatHud() {
  const status = useStatus();
  const c = status.combat;
  const now = useNow(c !== null);
  if (!c) return null;
  return (
    <>
      {status.playing && c.alive && <Crosshair />}
      <HitMarker c={c} now={now} />
      <DamageArcs c={c} now={now} />
      <KillFeed c={c} />
      <Announcements c={c} now={now} />
      {c.alive ? <Vitals c={c} /> : <DeathScreen c={c} />}
    </>
  );
}

/** The gap is driven every frame from the game loop through the --spread CSS variable. */
function Crosshair() {
  return (
    <div class="crosshair-lines" data-testid="crosshair">
      <i class="ch-top" />
      <i class="ch-bottom" />
      <i class="ch-left" />
      <i class="ch-right" />
    </div>
  );
}

function HitMarker({ c, now }: { c: CombatHudState; now: number }) {
  const age = now - c.hitAt;
  if (age > 350) return null;
  return (
    <div
      class={`hitmarker hm-${c.hitKind}`}
      style={{ opacity: 1 - age / 350 }}
      data-testid="hitmarker"
    />
  );
}

function DamageArcs({ c, now }: { c: CombatHudState; now: number }) {
  return (
    <>
      {c.damage
        .filter((d) => now - d.at < 1500)
        .map((d) => (
          <div
            key={d.key}
            class="damage-arc"
            style={{
              transform: `translate(-50%, -50%) rotate(${d.angle}deg)`,
              opacity: 1 - (now - d.at) / 1500,
            }}
          />
        ))}
    </>
  );
}

function KillFeed({ c }: { c: CombatHudState }) {
  return (
    <div class="killfeed" data-testid="killfeed">
      {c.killFeed.map((k) => (
        <div class="kf-row" key={k.key}>
          <span class={TEAM_CLASS[k.killerTeam]}>{k.killer}</span>
          <span class="kf-weapon">
            {k.weapon}
            {k.headshot ? ' ◎' : ''}
          </span>
          <span class={TEAM_CLASS[k.victimTeam]}>{k.victim}</span>
        </div>
      ))}
    </div>
  );
}

function Vitals({ c }: { c: CombatHudState }) {
  return (
    <div class="vitals">
      <div class="health" data-testid="health">
        <div class="health-bar">
          <div class="health-fill" style={{ width: `${c.health}%` }} data-low={c.health < 35} />
        </div>
        <span>{c.health}</span>
      </div>
      <div class="ammo" data-testid="ammo">
        <span class="ammo-mag">{c.reloading ? '—' : c.ammo}</span>
        <span class="ammo-reserve">/ {c.reserve}</span>
        <div class="weapon-name" data-testid="hud-weapon">
          {c.reloading ? 'reloading…' : c.weaponName}
        </div>
        <div class="grenades" data-testid="grenades">
          <span class="grenade-count" data-empty={c.frags === 0} title="Frag grenade">
            <kbd>G</kbd> frag ×{c.frags}
          </span>
          <span class="grenade-count" data-empty={c.smokes === 0} title="Smoke grenade">
            <kbd>Q</kbd> smoke ×{c.smokes}
          </span>
        </div>
      </div>
    </div>
  );
}

function DeathScreen({ c }: { c: CombatHudState }) {
  return (
    <div class="death" data-testid="death-screen">
      <div class="death-title">Eliminated{c.killedBy ? ` by ${c.killedBy}` : ''}</div>
      <div class="death-sub">Respawning in {Math.max(0, c.respawnSeconds).toFixed(1)} s</div>
    </div>
  );
}

/** "ELIMINATED Bot Heron +100", medals like DOUBLE KILL, for a couple of seconds. */
function Announcements({ c, now }: { c: CombatHudState; now: number }) {
  const live = c.announcements.filter((a) => now - a.at < 2500);
  if (live.length === 0) return null;
  return (
    <div class="announce" data-testid="announcements">
      {live.map((a) =>
        a.kind === 'medal' ? (
          <div class="announce-medal" key={a.key}>
            {a.text}
          </div>
        ) : (
          <div class="announce-kill" key={a.key}>
            {a.text}
            <span>{a.sub}</span>
          </div>
        ),
      )}
    </div>
  );
}
