import chatJson from './chat.json' with { type: 'json' };

/**
 * Chat profanity filter (data: chat.json). `substrings` are hidden wherever they appear inside
 * a word; `words` only as whole words (so "class" or "assassin" stay readable). Common letter
 * swaps (f*ck → 0/o, 1/i, 3/e, 4/a, 5/s, @, $) are undone before matching. The server filters
 * every line; the client never decides what others see.
 */
const blocked = chatJson as { substrings: string[]; words: string[] };

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

function normalize(word: string): string {
  let out = '';
  for (const ch of word.toLowerCase()) out += LEET[ch] ?? ch;
  // "fuuuck" → "fuck": collapse letters repeated 3+ times.
  return out.replace(/(.)\1{2,}/g, '$1');
}

function isBlocked(word: string): boolean {
  const n = normalize(word);
  const letters = n.replace(/[^a-z]/g, '');
  if (blocked.words.includes(n) || blocked.words.includes(letters)) return true;
  return blocked.substrings.some((s) => n.includes(s) || letters.includes(s));
}

/** Longest chat line in characters. */
export const CHAT_MAX_LENGTH = 120;

/**
 * Clean a chat line: no control characters, single spaces, at most CHAT_MAX_LENGTH characters,
 * blocked words replaced by asterisks. Returns '' if nothing is left to send.
 */
export function cleanChat(raw: string): string {
  // Control and invisible/bidi characters out (they can hide or reorder text).
  // eslint-disable-next-line no-control-regex
  const text = [...raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, '')]
    .slice(0, CHAT_MAX_LENGTH * 2)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text.split(' ').map((w) => {
    // Keep punctuation around the word ("fuck," → "****,"); $ and @ count as letters.
    const m = /^([^\p{L}\p{N}$@]*)(.*?)([^\p{L}\p{N}$@]*)$/u.exec(w)!;
    const core = m[2]!;
    return core && isBlocked(core)
      ? `${m[1]}${'*'.repeat(Math.min(8, [...core].length))}${m[3]}`
      : w;
  });
  return [...words.join(' ')].slice(0, CHAT_MAX_LENGTH).join('');
}
