import type { ClientStatus } from '../store.ts';
import type { MusicState } from './music.ts';

/**
 * Which music for the game's state: the theme in the menu and on the results screen, a
 * heartbeat during the countdown, quiet while playing (footsteps matter more).
 */
export function musicFor(s: Pick<ClientStatus, 'inMatch' | 'match'>): MusicState {
  if (!s.inMatch) return 'menu';
  const phase = s.match?.phase;
  if (phase === 'countdown') return 'countdown';
  if (phase === 'ended') return 'menu';
  return 'match';
}
