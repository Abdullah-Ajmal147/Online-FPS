/**
 * Progression rules live in content data (packages/content/src/progression.json), shared with
 * the game client's results screen. XP comes only from server-reported match results.
 */
export { MAX_LEVEL, levelFor, xpBreakdown, xpForMatch, xpToNext } from '@sentinel/content';
