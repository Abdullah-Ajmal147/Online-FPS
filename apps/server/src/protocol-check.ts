import { PROTOCOL_VERSION } from '@sentinel/protocol';

/** True when the join options carry the same PROTOCOL_VERSION as this server. */
export function isProtocolCompatible(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false;
  return (options as { protocolVersion?: unknown }).protocolVersion === PROTOCOL_VERSION;
}
