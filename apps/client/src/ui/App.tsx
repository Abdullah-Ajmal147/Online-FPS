import type { Settings } from '../settings.ts';
import { DebugOverlay } from './DebugOverlay.tsx';
import { Hud, useStatus } from './Hud.tsx';
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
      {status.playing ? <div class="crosshair" /> : <Menu {...props} />}
    </>
  );
}
