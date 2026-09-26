import { subscribe, type ClientStatus } from './store.ts';

/**
 * The host the game is embedded in (Phase 8 task 6). On our own site nothing needs telling;
 * on a portal like CrazyGames the SDK wants to know when the game has loaded and when the
 * player is actually playing (it pauses ads and banners around that), and a win is a
 * "happy time". Built in with VITE_PLATFORM=crazygames (`pnpm --filter @sentinel/client
 * build:crazygames`); every other build uses the no-op web platform.
 */
export interface Platform {
  readonly name: 'web' | 'crazygames';
  /** Links out of the game (Discord, our site) are not allowed on portals. */
  readonly externalLinks: boolean;
  loadingDone(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  happyTime(): void;
}

export const webPlatform: Platform = {
  name: 'web',
  externalLinks: true,
  loadingDone: () => {},
  gameplayStart: () => {},
  gameplayStop: () => {},
  happyTime: () => {},
};

/** The parts of the CrazyGames SDK v3 we call (window.CrazyGames.SDK). */
interface CrazySdk {
  init(): Promise<void>;
  game: {
    loadingStart(): void;
    loadingStop(): void;
    gameplayStart(): void;
    gameplayStop(): void;
    happytime(): void;
  };
}

/**
 * CrazyGames adapter. The SDK script is theirs and loads from their CDN at runtime (their
 * requirement; nothing is bundled). If it fails to load, the game still runs: every call is
 * then a no-op. Check against the current SDK docs before submitting.
 */
export function crazyGamesPlatform(sdkUrl: string): Platform {
  let sdk: CrazySdk | null = null;
  const ready = new Promise<void>((resolve) => {
    const script = document.createElement('script');
    script.src = sdkUrl;
    script.onload = () => {
      const found = (window as unknown as { CrazyGames?: { SDK?: CrazySdk } }).CrazyGames?.SDK;
      if (!found) return resolve();
      found
        .init()
        .then(() => {
          sdk = found;
          sdk.game.loadingStart();
        })
        .catch((err: unknown) => console.warn('[platform] CrazyGames SDK init failed:', err))
        .finally(resolve);
    };
    script.onerror = () => {
      console.warn('[platform] CrazyGames SDK did not load; continuing without it');
      resolve();
    };
    document.head.append(script);
  });
  const call = (f: (s: CrazySdk) => void) => void ready.then(() => sdk && f(sdk));
  return {
    name: 'crazygames',
    externalLinks: false,
    loadingDone: () => call((s) => s.game.loadingStop()),
    gameplayStart: () => call((s) => s.game.gameplayStart()),
    gameplayStop: () => call((s) => s.game.gameplayStop()),
    happyTime: () => call((s) => s.game.happytime()),
  };
}

/**
 * Tell the platform about state changes, once per change: gameplay = in a match, spawned and
 * in control (menus and the pause menu are not gameplay); a won match is a happy time.
 */
export function trackGameplay(
  platform: Platform,
  onStatus: (listener: (s: ClientStatus) => void) => void = subscribe,
): void {
  let playing = false;
  let celebrated = false;
  onStatus((s) => {
    const now = s.inMatch && s.spawned && s.playing;
    if (now !== playing) {
      playing = now;
      if (now) platform.gameplayStart();
      else platform.gameplayStop();
    }
    const won = s.match?.phase === 'ended' && s.match.result === 'win';
    if (won && !celebrated) platform.happyTime();
    celebrated = s.match?.phase === 'ended' ? celebrated || won : false;
  });
}

let current: Platform | undefined;

/** The platform this build targets (created on first use). */
export function platform(): Platform {
  current ??=
    import.meta.env.VITE_PLATFORM === 'crazygames'
      ? crazyGamesPlatform(
          (import.meta.env.VITE_CRAZYGAMES_SDK as string | undefined) ??
            'https://sdk.crazygames.com/crazygames-sdk-v3.js',
        )
      : webPlatform;
  return current;
}
