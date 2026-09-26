import { isBlockedWord } from '@sentinel/content';
/** Longest display name (fits the scoreboard and kill feed). */
export const MAX_NAME_LENGTH = 16;

/**
 * Clean a player-chosen name from the join options (untrusted): letters/digits in any script,
 * spaces, and _ . - only; whitespace collapsed; trimmed to 16 characters. Empty → "Player".
 * Names with a blocked word (chat filter) become "Player".
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Player';
  const clean = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^bot\s+/i, '') // "Bot …" is reserved for real bots
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  // No profanity in names either (same filter as chat).
  if (clean.split(' ').some((w) => isBlockedWord(w))) return 'Player';
  return clean.length > 0 ? clean : 'Player';
}
