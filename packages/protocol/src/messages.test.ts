import { describe, expect, it } from 'vitest';
import { decodeHello, encodeHello } from './messages.ts';

describe('Hello message', () => {
  it('round-trips', () => {
    const msg = { protocolVersion: 1, serverTickRate: 60 };
    expect(decodeHello(encodeHello(msg))).toEqual(msg);
  });
});
