import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  MAX_LEVEL,
  equipment,
  modes,
  movement,
  news,
  perkCatalog,
  progression,
  streakRewards,
  unlockLevel,
  weaponCatalog,
} from '@sentinel/content';
import { ACTIONS, ACTION_LABELS, keyLabel, type Settings } from '../settings.ts';
import { platform } from '../platform.ts';

/**
 * Help: how to play, what each mode and weapon does, and fixes for common problems. Every
 * number comes from the content data (and the keys from the player's own bindings), so the
 * page stays right when the game is re-tuned.
 */

const SECTIONS = [
  { id: 'basics', label: 'Basics' },
  { id: 'controls', label: 'Controls' },
  { id: 'modes', label: 'Modes' },
  { id: 'movement', label: 'Movement' },
  { id: 'weapons', label: 'Weapons' },
  { id: 'progress', label: 'Progress' },
  { id: 'problems', label: 'Problems' },
  { id: 'contact', label: 'Contact' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

const CLASS_NAMES: Record<string, string> = {
  rifle: 'Assault rifle',
  smg: 'SMG',
  shotgun: 'Shotgun',
  marksman: 'Marksman rifle',
  sidearm: 'Sidearm',
};

const minutes = (s: number) => `${Math.round(s / 60)} min`;

/** Weapons in the order you get them. */
const byUnlock = [...weaponCatalog].sort(
  (a, b) => unlockLevel('weapons', a.id) - unlockLevel('weapons', b.id),
);

export function HelpGuide({
  settings,
  onFeedback,
}: {
  settings: Settings;
  /** Open the Comms screen's feedback form. */
  onFeedback: () => void;
}) {
  const [section, setSection] = useState<Section>('basics');
  const k = (code: string) => <kbd>{keyLabel(code)}</kbd>;
  const b = settings.bindings;

  return (
    <div class="help" data-testid="help">
      <div class="tabs help-tabs" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={section === s.id}
            class={`tab${section === s.id ? ' active' : ''}`}
            data-testid={`help-tab-${s.id}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'basics' && (
        <div class="help-body">
          <p class="lead">
            Sentinel Strike is a 6 v 6 team shooter in the browser. Pick a playlist on the Play
            screen and press <strong>Deploy</strong>: you join a match right away, and bots fill
            empty places until more people join.
          </p>
          <ol class="help-steps">
            <li>
              Click the game to take control of the mouse. {k('Escape')} gives it back and opens
              this menu (the match keeps going).
            </li>
            <li>
              Move with {k(b.forward)} {k(b.left)} {k(b.back)} {k(b.right)}, aim with the mouse,
              left click to fire, hold right click to aim down sights.
            </li>
            <li>
              Work with your team: stay near teammates, use cover, and reload ({k(b.reload)}) behind
              it.
            </li>
            <li>
              Out of fire for a few seconds, you heal. When you're eliminated you respawn after a
              short wait.
            </li>
            <li>
              Hold {k('Tab')} for the scoreboard. Every match earns XP, which unlocks weapons and
              perks (see Progress).
            </li>
          </ol>
          <p class="muted">
            The first match shows short tips on screen. To see them again: Settings → Game →
            First-match tips.
          </p>
        </div>
      )}

      {section === 'controls' && (
        <div class="help-body">
          <table class="help-table" data-testid="help-controls">
            <tbody>
              {ACTIONS.map((a) => (
                <tr key={a}>
                  <td>{ACTION_LABELS[a]}</td>
                  <td>{k(b[a])}</td>
                </tr>
              ))}
              <tr>
                <td>Fire</td>
                <td>Left mouse</td>
              </tr>
              <tr>
                <td>Aim down sights</td>
                <td>Right mouse (hold)</td>
              </tr>
              <tr>
                <td>Swap weapon</td>
                <td>Mouse wheel</td>
              </tr>
              <tr>
                <td>Zoom in / out (while aiming)</td>
                <td>Mouse wheel up / down</td>
              </tr>
              <tr>
                <td>Chat to everyone / team</td>
                <td>
                  {k('Enter')} / {k('KeyT')}
                </td>
              </tr>
              <tr>
                <td>Scoreboard</td>
                <td>{k('Tab')} (hold)</td>
              </tr>
              <tr>
                <td>Menu (pause)</td>
                <td>{k('Escape')}</td>
              </tr>
              <tr>
                <td>Network and FPS stats</td>
                <td>{k('F3')}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted">
            These are your current keys. Change any of them in Settings → Controls.
          </p>
        </div>
      )}

      {section === 'modes' && (
        <div class="help-body">
          {Object.values(modes).map((m) => (
            <div class="panel" key={m.id} data-testid={`help-mode-${m.id}`}>
              <div class="panel-h">{m.name}</div>
              <p>
                {m.playersPerTeam} v {m.playersPerTeam} · first to {m.scoreLimit}{' '}
                {m.capture ? 'points' : 'eliminations'} · {minutes(m.timeLimitSeconds)}. If time
                runs out, the team ahead wins.
              </p>
              {m.capture ? (
                <ul>
                  <li>
                    Three relay nodes: A, B and C. Stand inside a node's ring ({m.capture.radius} m)
                    for {m.capture.seconds} s to capture it; teammates on it make it faster, and an
                    enemy on it stops the capture.
                  </li>
                  <li>
                    Every node your team holds scores 1 point every {m.capture.scoreIntervalSeconds}{' '}
                    s. A kill scores {m.capture.scorePerKill}.
                  </li>
                  <li>
                    So the big number is <strong>points, not kills</strong>: "+1 node" and "+
                    {m.capture.scorePerKill} kill" show under the score bar, and the scoreboard (
                    {k('Tab')}) splits each team's points into kills and nodes.
                  </li>
                </ul>
              ) : (
                <ul>
                  <li>Each elimination scores 1 for your team.</li>
                </ul>
              )}
            </div>
          ))}
          <div class="panel">
            <div class="panel-h">Private matches</div>
            <p>
              On the Play screen, create a private match and send the invite link to your friends.
              Only people with the link can join, and you can switch teams from the pause menu.
            </p>
          </div>
        </div>
      )}

      {section === 'movement' && (
        <div class="help-body">
          <table class="help-table">
            <tbody>
              <tr>
                <td>Walk</td>
                <td>{movement.walkSpeed} m/s</td>
              </tr>
              <tr>
                <td>Sprint (hold {k(b.sprint)})</td>
                <td>{movement.sprintSpeed} m/s, weapon lowered</td>
              </tr>
              <tr>
                <td>Tactical sprint (double-tap {k(b.sprint)})</td>
                <td>
                  {movement.tacSprintSpeed} m/s for up to {movement.tacSprintDuration} s, then{' '}
                  {movement.tacSprintCooldown} s to recharge
                </td>
              </tr>
              <tr>
                <td>Slide (sprint, then {k(b.crouch)})</td>
                <td>a burst of speed; jump out of it to keep the speed for one hop</td>
              </tr>
              <tr>
                <td>Mantle ({k(b.jump)} at cover while moving forward)</td>
                <td>
                  climbs over anything {movement.mantleMinHeight}–{movement.mantleMaxHeight} m high
                  (cars, crates, low walls)
                </td>
              </tr>
              <tr>
                <td>Crouch ({k(b.crouch)})</td>
                <td>{movement.crouchSpeed} m/s, quieter footsteps, steadier aim</td>
              </tr>
              <tr>
                <td>Turn with keys</td>
                <td>
                  {k(b.turnLeft)} {k(b.turnRight)}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="muted">
            You can't fire while sprinting or mantling: let go of sprint a moment before a fight.
          </p>
        </div>
      )}

      {section === 'weapons' && (
        <div class="help-body">
          <table class="help-table help-weapons" data-testid="help-weapons">
            <thead>
              <tr>
                <th>Weapon</th>
                <th>Type</th>
                <th>Damage per hit (body / head)</th>
                <th>Fire rate</th>
                <th>Magazine</th>
                <th>Zoom</th>
                <th>Unlocks</th>
              </tr>
            </thead>
            <tbody>
              {byUnlock.map((w) => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>{CLASS_NAMES[w.class] ?? w.class}</td>
                  <td>
                    {w.damage.torso}
                    {w.pellets > 1 ? ` × ${w.pellets}` : ''} / {w.damage.head}
                    {w.pellets > 1 ? ` × ${w.pellets}` : ''}
                  </td>
                  <td>{w.rpm} rpm</td>
                  <td>{w.magazine}</td>
                  <td>{w.zoomLevels.map((z) => `${z}×`).join(' ')}</td>
                  <td>
                    {unlockLevel('weapons', w.id) <= 1
                      ? 'from the start'
                      : `level ${unlockLevel('weapons', w.id)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul>
            <li>
              Headshots do the most damage on every weapon. Damage drops a little at long range.
            </li>
            <li>
              Hip fire is for close range; aiming down sights tightens your spread. While aiming,
              the mouse wheel zooms in and out (the Zoom column), and the mouse slows down with the
              zoom so small head adjustments are easy.
            </li>
            <li>
              Everyone carries a {equipment.frag.name.toLowerCase()} ({k(b.lethal)}) and a{' '}
              {equipment.smoke.name.toLowerCase()} ({k(b.tactical)}). Frags bounce off walls; nobody
              can see through smoke.
            </li>
            <li>Shotguns fire several pellets per shot ("× 8"): up close, most of them hit.</li>
            <li>Choose your weapons, attachments and perks on the Loadout screen.</li>
            <li data-testid="help-streaks">
              Kill streaks (kills without dying):{' '}
              {streakRewards
                .map(
                  (s) =>
                    `${s.kills} kills: ${s.name}` +
                    (s.reward === 'radar'
                      ? ` (your team sees every enemy for ${s.seconds} s)`
                      : s.reward === 'resupply'
                        ? ' (full ammo and grenades)'
                        : ` (${Math.round((1 - (s.damageTaken ?? 1)) * 100)}% less damage for ${s.seconds} s)`),
                )
                .join(' · ')}
              .
            </li>
          </ul>
        </div>
      )}

      {section === 'progress' && (
        <div class="help-body">
          <table class="help-table">
            <tbody>
              <tr>
                <td>Playing a match</td>
                <td>+{progression.xp.participation} XP</td>
              </tr>
              <tr>
                <td>Each kill</td>
                <td>+{progression.xp.perKill} XP</td>
              </tr>
              <tr>
                <td>Each headshot kill</td>
                <td>+{progression.xp.perHeadshot} XP more</td>
              </tr>
              <tr>
                <td>Win / draw</td>
                <td>
                  +{progression.xp.win} / +{progression.xp.draw} XP
                </td>
              </tr>
            </tbody>
          </table>
          <ul>
            <li>
              Levels 1–{MAX_LEVEL}. New weapons and perks unlock as you level up:{' '}
              {progression.accountUnlocks
                .map(
                  (u) =>
                    `level ${u.level}: ${[
                      ...u.weapons.map((id) => weaponCatalog.find((w) => w.id === id)?.name ?? id),
                      ...u.perks.map((id) => perkCatalog.find((p) => p.id === id)?.name ?? id),
                    ].join(', ')}`,
                )
                .join(' · ')}
              .
            </li>
            <li>
              Kills with a weapon level up that weapon and unlock its attachments (grips, stocks,
              scopes…).
            </li>
            <li>Daily challenges on the Play screen give extra XP. Career shows your stats.</li>
            <li>
              Private matches count for XP only with 4 or more real players, so XP can't be farmed
              against bots.
            </li>
          </ul>
        </div>
      )}

      {section === 'problems' && (
        <div class="help-body help-faq" data-testid="help-faq">
          <Faq q="I can't turn while running (laptop touchpad)">
            Many laptops switch the touchpad off while keys are held. Turn with {k(b.turnLeft)}{' '}
            {k(b.turnRight)}, use a mouse, or turn off "disable touchpad while typing" in your
            system's touchpad settings.
          </Faq>
          <Faq q="The mouse doesn't aim">
            Click inside the game once to lock the mouse to it. {k('Escape')} releases it.
          </Faq>
          <Faq q="The game is slow or stutters">
            Settings → Graphics: choose Low, lower the render scale, keep automatic resolution on.
            Close other heavy tabs, and make sure hardware acceleration is on in your browser
            (Chrome or Edge work best).
          </Faq>
          <Faq q="High ping or players jumping around">
            Pick the region nearest to you on the Play screen, and use a wired connection if you
            can. {k('F3')} shows your ping and packet loss.
          </Faq>
          <Faq q="No sound">
            Browsers only start sound after you click the page. Check Settings → Audio and your tab
            isn't muted.
          </Faq>
          <Faq q="The page asks me to reload">
            A new version of the game is out. Reload the page to get it.
          </Faq>
          <Faq q="Domination score went up but nobody got a kill">
            Held nodes score over time. See Modes, or hold {k('Tab')}: the scoreboard shows points
            from kills and from nodes.
          </Faq>
          <Faq q="Where did my progress go?">
            Progress is saved to your guest profile in this browser. Clearing site data or using
            another browser or device starts a new profile.
          </Faq>
          <Faq q="Someone is cheating or abusive">
            Press {k('Escape')} during the match, open Squad, and use Report next to their name.
            Reports go to the moderators.
          </Faq>
          <Faq q="How do I play with friends?">
            Squad: share your friend code and join friends' matches. Or create a private match on
            the Play screen and send the invite link.
          </Faq>
        </div>
      )}

      {section === 'contact' && (
        <div class="help-body">
          <div class="panel">
            <div class="panel-h">Still stuck, or found a bug?</div>
            <p>
              Send a message straight to the developer. Say what you were doing (map, mode, weapon):
              your game version and browser are added automatically.
            </p>
            <button class="btn" data-testid="help-feedback" onClick={onFeedback}>
              Send feedback
            </button>
          </div>
          {news.community.discord && platform().externalLinks && (
            <div class="panel">
              <div class="panel-h">Community</div>
              <p>Ask other players, find a squad, share clips.</p>
              <a
                class="btn"
                href={news.community.discord}
                target="_blank"
                rel="noopener noreferrer"
              >
                Join the Discord
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Faq({ q, children }: { q: string; children: ComponentChildren }) {
  return (
    <details class="panel faq">
      <summary class="panel-h">{q}</summary>
      <p>{children}</p>
    </details>
  );
}
