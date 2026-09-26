import { describe, expect, it } from 'vitest';
import { CONTENT_HASH } from '@sentinel/content';
import { PROTOCOL_VERSION } from '@sentinel/protocol';
import { isProtocolCompatible } from './protocol-check.ts';

const ok = { protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH };

describe('isProtocolCompatible', () => {
  it('accepts the current version and content', () => {
    expect(isProtocolCompatible(ok)).toBe(true);
  });

  it('rejects other versions, missing versions and junk', () => {
    expect(isProtocolCompatible({ ...ok, protocolVersion: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isProtocolCompatible({ ...ok, protocolVersion: String(PROTOCOL_VERSION) })).toBe(false);
    expect(isProtocolCompatible({})).toBe(false);
    expect(isProtocolCompatible(null)).toBe(false);
    expect(isProtocolCompatible(undefined)).toBe(false);
  });

  it('rejects a client built from different content (weapon indices would disagree)', () => {
    expect(isProtocolCompatible({ ...ok, contentHash: 'deadbeef' })).toBe(false);
    expect(isProtocolCompatible({ protocolVersion: PROTOCOL_VERSION })).toBe(false);
  });
});
