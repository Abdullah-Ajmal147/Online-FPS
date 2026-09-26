import { h, render } from 'preact';
import { startGame, type Game } from './game/game.ts';
import { refreshProfile } from './profile.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { getStatus, setStatus, subscribe } from './store.ts';
import { startSessionTelemetry } from './telemetry.ts';
import { platform, trackGameplay } from './platform.ts';
import { gameAudio } from './audio/index.ts';
import { musicFor } from './audio/director.ts';
import { probeRegions, regions } from './regions.ts';
import { App } from './ui/App.tsx';

let settings: Settings = loadSettings();
void probeRegions(regions());
startSessionTelemetry();

// Audio: browsers allow sound only after a gesture, so the first click or key anywhere starts
// it (menu music included). Volumes follow the settings; music follows the match state.
const applyVolumes = () =>
  gameAudio.setVolumes({
    master: settings.volumeMaster,
    music: settings.volumeMusic,
    effects: settings.volumeEffects,
  });
applyVolumes();
for (const type of ['pointerdown', 'keydown'] as const)
  addEventListener(type, () => gameAudio.unlock(), { once: true, capture: true });
subscribe((s) => gameAudio.setMusic(musicFor(s)));
gameAudio.setMusic(musicFor(getStatus()));
// A soft tick for menu buttons.
addEventListener('click', (e) => {
  if ((e.target as Element | null)?.closest?.('.menu button')) gameAudio.uiClick();
});
trackGameplay(platform());
let game: Game | undefined;
/** DEPLOY pressed before the game finished loading. */
let wantToJoin = false;
// Opened by a friend's Join button (?room=…&with=…&join=1): join as soon as the game has
// loaded; the first click then captures the mouse (browsers need a click for that).
if (new URLSearchParams(location.search).get('join') === '1') {
  wantToJoin = true;
  const url = new URL(location.href);
  url.searchParams.delete('join'); // a reload later shouldn't rejoin by itself
  history.replaceState(null, '', url);
}

const ui = document.getElementById('ui')!;
const rerender = () =>
  render(
    h(App, {
      settings,
      onSettings: (next: Settings) => {
        settings = next;
        saveSettings(next);
        applyVolumes();
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
