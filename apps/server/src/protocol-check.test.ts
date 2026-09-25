import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@sentinel/protocol';
import { isProtocolCompatible } from './protocol-check.ts';

describe('isProtocolCompatible', () => {
  it('accepts the current version', () => {
    expect(isProtocolCompatible({ protocolVersion: PROTOCOL_VERSION })).toBe(true);
  });

  it('rejects other versions, missing versions and junk', () => {
    expect(isProtocolCompatible({ protocolVersion: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isProtocolCompatible({ protocolVersion: String(PROTOCOL_VERSION) })).toBe(false);
    expect(isProtocolCompatible({})).toBe(false);
    expect(isProtocolCompatible(null)).toBe(false);
    expect(isProtocolCompatible(undefined)).toBe(false);
  });
});
