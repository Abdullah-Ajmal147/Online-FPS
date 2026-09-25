/** Longest display name (fits the scoreboard and kill feed). */
export const MAX_NAME_LENGTH = 16;

/**
 * Clean a player-chosen name from the join options (untrusted): letters/digits in any script,
 * spaces, and _ . - only; whitespace collapsed; trimmed to 16 characters. Empty → "Player".
 * (Profanity filtering comes with accounts in Phase 4.)
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
  return clean.length > 0 ? clean : 'Player';
}
