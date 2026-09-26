import type { Settings } from '../settings.ts';
import { Chat } from './Chat.tsx';
import { CombatHud } from './CombatHud.tsx';
import { DebugOverlay } from './DebugOverlay.tsx';
import { Hud, useStatus } from './Hud.tsx';
import { MatchUi } from './MatchUi.tsx';
import { Menu } from './Menu.tsx';

interface Props {
  settings: Settings;
  onSettings: (next: Settings) => void;
  onPlay: () => void;
}

export function App(props: Props) {
  const status = useStatus();
  return (
    <>
      <Hud />
      <DebugOverlay />
      <CombatHud />
      <MatchUi />
      <Chat />
      {!status.playing && <Menu {...props} />}
    </>
  );
}
