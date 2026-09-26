import chatJson from './chat.json' with { type: 'json' };

/**
 * Chat profanity filter (data: chat.json), run by the server on every line.
 * - `substrings` are hidden inside any word, `words` only as whole words, `allow` (prefixes)
 *   are never hidden ("Scunthorpe", "shiitake").
 * - Words are normalised first: Unicode NFKC (fullwidth → ASCII), look-alike letters from
 *   other scripts, common swaps (0→o, 1→i, 3→e, 4→a, 5→s, $, @, ph→f …), letters only.
 * - Stretched spellings match: every letter of a blocked stem may repeat ("fuuuck").
 * - Spaced-out letters are joined and checked too ("f u c k").
 * - Invisible, bidi and other control characters are removed from every line.
 */
const data = chatJson as { substrings: string[]; words: string[]; allow: string[] };

/** Look-alike letters (Cyrillic, Greek, Armenian) → Latin. */
const CONFUSABLE: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ɡ: 'g',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ս: 'u',
  օ: 'o',
  ց: 'g',
  հ: 'h',
  ո: 'n',
};
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '(': 'c',
  '+': 't',
};

function normalizeWord(word: string): string {
  let out = '';
  for (const ch of word.normalize('NFKC').toLowerCase()) out += CONFUSABLE[ch] ?? LEET[ch] ?? ch;
  return out.replace(/ph/g, 'f').replace(/[^a-z]/g, '');
}

/** "fuck" → /f+u+c+k+/, "ass" → /a+s{2,}/: each letter may repeat, doubled ones stay double. */
function stemPattern(stem: string, whole: boolean): RegExp {
  let body = '';
  for (let i = 0; i < stem.length;) {
    let j = i;
    while (stem[j] === stem[i]) j++;
    body += `${stem[i]}{${j - i},}`;
    i = j;
  }
  return new RegExp(whole ? `^${body}$` : body);
}

const substringPatterns = data.substrings.map((s) => stemPattern(s, false));
const wordPatterns = data.words.map((w) => stemPattern(w, true));

export function isBlockedWord(word: string): boolean {
  const n = normalizeWord(word);
  if (!n || data.allow.some((a) => n.startsWith(a))) return false;
  return wordPatterns.some((p) => p.test(n)) || substringPatterns.some((p) => p.test(n));
}

/** Longest chat line in characters. */
export const CHAT_MAX_LENGTH = 120;

/** Invisible or text-reordering characters: control, format (bidi, zero-width), fillers. */
// The class deliberately lists combining characters (variation selectors) to remove them.
/* eslint-disable no-misleading-character-class */
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0\u2800\ufe00-\ufe0f\u{e0000}-\u{e007f}]/gu;
/* eslint-enable no-misleading-character-class */

const stars = (s: string) => '*'.repeat(Math.min(8, [...s].length));

/** Split a token into leading punctuation, the word, trailing punctuation ($ @ count as letters). */
function parts(token: string): [string, string, string] {
  const m = /^([^\p{L}\p{N}$@]*)(.*?)([^\p{L}\p{N}$@]*)$/u.exec(token)!;
  return [m[1]!, m[2]!, m[3]!];
}

/**
 * Clean a chat line: invisible characters removed, single spaces, at most CHAT_MAX_LENGTH
 * characters, blocked words replaced by asterisks. Returns '' if nothing visible is left.
 */
export function cleanChat(raw: string): string {
  const text = raw
    .slice(0, CHAT_MAX_LENGTH * 4)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\u034f/g, '') // combining grapheme joiner (invisible; not allowed in a class)
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(text)) return '';
  const tokens = text.split(' ');
  const out = tokens.map((t) => {
    const [pre, core, post] = parts(t);
    return core && isBlockedWord(core) ? `${pre}${stars(core)}${post}` : t;
  });
  // Spaced-out letters ("f u c k"): join runs of one-letter words and check them together.
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j < tokens.length && [...parts(tokens[j]!)[1]].length === 1) j++;
    if (
      j - i >= 2 &&
      isBlockedWord(
        tokens
          .slice(i, j)
          .map((t) => parts(t)[1])
          .join(''),
      )
    ) {
      for (let k = i; k < j; k++) out[k] = '*';
    }
    i = Math.max(j, i + 1);
  }
  return [...out.join(' ')].slice(0, CHAT_MAX_LENGTH).join('');
}
