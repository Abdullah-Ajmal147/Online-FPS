import { describe, expect, it } from 'vitest';
import { MAX_NAME_LENGTH, sanitizeName } from './names.ts';

describe('sanitizeName', () => {
  it('keeps normal names, in any script', () => {
    expect(sanitizeName('Ayesha')).toBe('Ayesha');
    expect(sanitizeName('Ali_99')).toBe('Ali_99');
    expect(sanitizeName('محمد')).toBe('محمد');
  });

  it('strips markup, control characters and emoji; collapses spaces', () => {
    expect(sanitizeName('<script>x</script>')).toBe('scriptxscript');
    expect(sanitizeName('a\u0000b‮c')).toBe('abc');
    expect(sanitizeName('  lots   of   space  ')).toBe('lots of space');
  });

  it('reserves the "Bot " prefix for real bots', () => {
    expect(sanitizeName('Bot Heron')).toBe('Heron');
    expect(sanitizeName('bot   x')).toBe('x');
    expect(sanitizeName('Botany')).toBe('Botany');
  });

  it('limits length and falls back to Player', () => {
    expect(sanitizeName('x'.repeat(50))).toHaveLength(MAX_NAME_LENGTH);
    expect(sanitizeName('')).toBe('Player');
    expect(sanitizeName('!!!')).toBe('Player');
    expect(sanitizeName(42)).toBe('Player');
  });
});
