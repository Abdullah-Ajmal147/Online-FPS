import { h, render } from 'preact';
import { startGame, type Game } from './game/game.ts';
import { refreshProfile } from './profile.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { getStatus, setStatus } from './store.ts';
import { startSessionTelemetry } from './telemetry.ts';
import { platform, trackGameplay } from './platform.ts';
import { probeRegions, regions } from './regions.ts';
import { App } from './ui/App.tsx';

let settings: Settings = loadSettings();
void probeRegions(regions());
startSessionTelemetry();
trackGameplay(platform());
let game: Game | undefined;
/** DEPLOY pressed before the game finished loading. */
let wantToJoin = false;

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
      onPlay: () => {
        // DEPLOY: join the match (first time), then capture the mouse. RESUME: just capture.
        if (!game) {
          // Still loading (3D engine, physics): remember the click and join when ready.
          wantToJoin = true;
          setStatus({ net: { state: 'connecting', text: 'loading…' } });
          return;
        }
        void game.join();
        void game.requestPlay();
      },
      onLeave: () => game?.leave(),
    }),
    ui,
  );
rerender();
void refreshProfile(); // level/XP card in the menu

const canvas = document.getElementById('scene') as HTMLCanvasElement;
// Clicking the game view resumes (only once a match is joined; the main menu needs DEPLOY).
canvas.addEventListener('click', () => {
  if (getStatus().inMatch) void game?.requestPlay();
});

startGame(canvas, () => settings)
  .then((g) => {
    game = g;
    void probeRegions(regions()); // again, now that loading no longer blocks the page
    if (wantToJoin) void g.join(); // the mouse is captured on the next click (RESUME)
    setStatus({ backend: g.backend });
    platform().loadingDone();
  })
  .catch((err: unknown) => {
    console.error('[game] failed to start:', err);
    // Almost always: no WebGL (blocked, hardware acceleration off, or the GPU gave up).
    setStatus({
      net: {
        state: 'error',
        text: 'Could not start 3D graphics. Enable hardware acceleration or try another browser.',
      },
    });
  });
