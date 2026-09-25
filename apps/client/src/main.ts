import { h, render } from 'preact';
import { startGame, type Game } from './game/game.ts';
import { refreshProfile } from './profile.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { setStatus } from './store.ts';
import { App } from './ui/App.tsx';

let settings: Settings = loadSettings();
let game: Game | undefined;

const ui = document.getElementById('ui')!;
const rerender = () =>
  render(
    h(App, {
      settings,
      onSettings: (next: Settings) => {
        settings = next;
        saveSettings(next);
        rerender();
      },
      onPlay: () => void game?.requestPlay(),
    }),
    ui,
  );
rerender();
void refreshProfile(); // level/XP card in the menu

const canvas = document.getElementById('scene') as HTMLCanvasElement;
canvas.addEventListener('click', () => void game?.requestPlay());

startGame(canvas, () => settings)
  .then((g) => {
    game = g;
    setStatus({ backend: g.backend });
  })
  .catch((err: unknown) => console.error('[game] failed to start:', err));
