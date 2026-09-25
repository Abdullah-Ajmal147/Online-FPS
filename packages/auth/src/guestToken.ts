import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Signed guest tokens (server-side only; never import this in the browser).
 *
 * Format: `g1.<guestId>.<issuedAtSeconds>.<hex HMAC-SHA256 of "g1.<guestId>.<issuedAt>">`.
 * The API issues them; the API and the game server verify them with the shared secret, so a
 * client can't claim someone else's guest id. Supabase guest accounts can replace this in
 * Phase 4 without changing callers (they only need `guestId` from a verified token).
 */
const VERSION = 'g1';
/** Tokens older than this are refused (the client then asks for a new guest). */
export const TOKEN_MAX_AGE_SECONDS = 365 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function issueGuestToken(secret: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const guestId = randomUUID();
  const payload = `${VERSION}.${guestId}.${nowSeconds}`;
  return { guestId, token: `${payload}.${mac(payload, secret)}` };
}

/** The guest id inside a valid, unexpired token; null for anything else. */
export function verifyGuestToken(
  token: unknown,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, guestId, issued, signature] = parts as [string, string, string, string];
  if (
    version !== VERSION ||
    !UUID.test(guestId) ||
    !/^\d{1,12}$/.test(issued) ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return null;
  }
  const age = nowSeconds - Number(issued);
  if (age < -300 || age > TOKEN_MAX_AGE_SECONDS) return null;
  const expected = Buffer.from(mac(`${version}.${guestId}.${issued}`, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? guestId : null;
}
