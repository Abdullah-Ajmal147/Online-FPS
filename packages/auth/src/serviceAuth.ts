import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Game server ↔ API requests are signed with the shared server secret. The signed text names
 * its purpose and carries the time, so a signature is only good for that one kind of request
 * and for about a minute (a signature seen in a log can't be replayed later or reused for
 * something else):  `<purpose>:v1:<unixSeconds>:<payload>`.
 */
export type ServicePurpose = 'match' | 'access' | 'presence';

export const MAX_CLOCK_SKEW_SECONDS = 60;

export function signService(
  secret: string,
  purpose: ServicePurpose,
  payload: string,
  unixSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${purpose}:v1:${unixSeconds}:${payload}`)
    .digest('hex');
}

/** Headers for a signed request, made now. */
export function serviceHeaders(
  secret: string,
  purpose: ServicePurpose,
  payload: string,
  nowMs = Date.now(),
): Record<string, string> {
  const t = Math.floor(nowMs / 1000);
  return {
    'x-sentinel-time': String(t),
    'x-sentinel-signature': signService(secret, purpose, payload, t),
  };
}

export function verifyService(
  secret: string,
  purpose: ServicePurpose,
  payload: string,
  time: string | undefined,
  signature: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!time || !/^\d{1,12}$/.test(time) || !signature || !/^[0-9a-f]{64}$/.test(signature))
    return false;
  const t = Number(time);
  if (Math.abs(nowMs / 1000 - t) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = Buffer.from(signService(secret, purpose, payload, t), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/**
 * "Everything unlocked" (local play and tests). Off unless SENTINEL_UNLOCK_ALL=1 is set, in
 * every process that honours it (API and game server), so a forgotten NODE_ENV can't turn it
 * on in production.
 */
export function resolveUnlockAll(env: Record<string, string | undefined>): boolean {
  return env.SENTINEL_UNLOCK_ALL === '1';
}

/**
 * A player's public code (friends, recent players): derived from the guest id with the server
 * secret, so it can be shown to other players without revealing the id itself.
 */
export function publicCode(secret: string, guestId: string): string {
  return createHmac('sha256', secret).update(`code:v1:${guestId}`).digest('hex').slice(0, 16); // 64 bits: no collisions at any realistic scale
}

/**
 * A player's IP as a keyed hash: lets bans cover a connection without storing IP addresses.
 * Only the game server (which sees the IP) and the API (which stores the hash) use it.
 */
export function ipHash(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(`ip:v1:${ip}`).digest('hex').slice(0, 16);
}

/** Opaque id of the shadow pool (moderated players' rooms): says nothing to a client. */
export function shadowPoolId(secret: string): string {
  return createHmac('sha256', secret).update('pool:v1:shadow').digest('hex').slice(0, 12);
}
