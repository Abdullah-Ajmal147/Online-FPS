import { lore, maps, news } from '@sentinel/content';
import { useState } from 'preact/hooks';
import type { Settings } from '../settings.ts';
import { Chat } from './Chat.tsx';
import { CombatHud } from './CombatHud.tsx';
import { DebugOverlay } from './DebugOverlay.tsx';
import { useStatus } from './Hud.tsx';
import { MatchUi } from './MatchUi.tsx';
import { primerDone } from '../primer.ts';
import { Primer } from './Primer.tsx';
import { Menu } from './Menu.tsx';

interface Props {
  settings: Settings;
  onSettings: (next: Settings) => void;
  onPlay: () => void;
  onLeave: () => void;
}

export function App(props: Props) {
  const status = useStatus();
  const deploying =
    status.inMatch && (status.net.state !== 'connected' || !status.match || !status.spawned);
  return (
    <>
      {status.inMatch && (
        <>
          <CombatHud />
          <MatchUi />
          <Chat />
          {!primerDone() && status.spawned && status.playing && status.combat?.alive !== false && (
            <Primer settings={props.settings} />
          )}
        </>
      )}
      <DebugOverlay />
      {deploying && status.playing && <DeployScreen />}
      {!status.playing && <Menu {...props} />}
    </>
  );
}

/** The few seconds between DEPLOY and spawning: where you're going and for whom. */
function DeployScreen() {
  const status = useStatus();
  const map = maps[status.mapId] ?? maps['relay-yard']!;
  const team = status.match ? lore.factions[status.match.myTeam] : undefined;
  // A different tip each deploy (UI only; nothing simulated depends on it).
  const [tip] = useState(() => news.tips[Math.floor(Math.random() * news.tips.length)]!);
  return (
    <div class="deploy-screen" data-testid="deploying">
      <div class="map-kicker">Deploying</div>
      <div class="map-name">{map.name}</div>
      <div class="map-loc">{map.location}</div>
      <p>{map.description}</p>
      {team && (
        <div class={`notice faction-${team.id}`}>
          {team.name} · {team.motto}
        </div>
      )}
      <div class="tip" data-testid="deploy-tip">
        <b>Tip</b> {tip}
      </div>
      <div class="net-line">
        <span class="status-dot" data-state={status.net.state} /> {status.net.text}
      </div>
    </div>
  );
}
