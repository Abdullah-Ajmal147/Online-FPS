import { CONTENT_HASH } from '@sentinel/content';
import { PROTOCOL_VERSION } from '@sentinel/protocol';

/**
 * True when the join options carry the same PROTOCOL_VERSION and content (weapons, equipment,
 * movement) as this server. Either mismatch means an outdated client: it must reload.
 */
export function isProtocolCompatible(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false;
  const o = options as { protocolVersion?: unknown; contentHash?: unknown };
  return o.protocolVersion === PROTOCOL_VERSION && o.contentHash === CONTENT_HASH;
}
