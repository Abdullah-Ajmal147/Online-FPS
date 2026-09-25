export const DEV_SECRET = 'dev-only-secret';
let warned = false;

/**
 * The shared secret that signs guest tokens and match results. In development it falls back
 * to a well-known value; in production (NODE_ENV=production) the process refuses to start
 * unless a real secret (32+ characters, not the dev value) is set — a public default would
 * let anyone forge XP or impersonate players.
 */
export function resolveApiSecret(env: Record<string, string | undefined>): string {
  const secret = env.SENTINEL_API_SECRET;
  const production = env.NODE_ENV === 'production';
  if (!secret || secret === DEV_SECRET) {
    if (production) {
      throw new Error(
        'SENTINEL_API_SECRET must be set to a random value of 32+ characters in production',
      );
    }
    if (!warned) {
      console.warn(
        '[auth] SENTINEL_API_SECRET not set: using the development secret (never in production)',
      );
      warned = true;
    }
    return DEV_SECRET;
  }
  if (production && secret.length < 32)
    throw new Error('SENTINEL_API_SECRET must be at least 32 characters');
  return secret;
}
