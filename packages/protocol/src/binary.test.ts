import { describe, expect, it } from 'vitest';
import { BinaryReader, BinaryWriter } from './binary.ts';
import { PROTOCOL_VERSION } from './version.ts';

describe('BinaryWriter / BinaryReader', () => {
  it('round-trips every primitive type', () => {
    const w = new BinaryWriter(4); // small on purpose: forces growth
    w.u8(255).i8(-128).u16(65535).i16(-32768).u32(4294967295).i32(-2147483648);
    w.f32(1.5).f64(Math.PI).string('héllo, sentinel');

    const r = new BinaryReader(w.finish());
    expect(r.u8()).toBe(255);
    expect(r.i8()).toBe(-128);
    expect(r.u16()).toBe(65535);
    expect(r.i16()).toBe(-32768);
    expect(r.u32()).toBe(4294967295);
    expect(r.i32()).toBe(-2147483648);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(Math.PI);
    expect(r.string()).toBe('héllo, sentinel');
    expect(r.remaining).toBe(0);
  });

  it('writes little-endian', () => {
    const bytes = new BinaryWriter().u16(0x0102).finish();
    expect([...bytes]).toEqual([0x02, 0x01]);
  });

  it('reads from a subarray with a non-zero byteOffset', () => {
    const inner = new BinaryWriter().u32(123456).finish();
    const padded = new Uint8Array(inner.length + 3);
    padded.set(inner, 3);
    expect(new BinaryReader(padded.subarray(3)).u32()).toBe(123456);
  });

  it('throws when reading past the end', () => {
    const r = new BinaryReader(new BinaryWriter().u8(1).finish());
    r.u8();
    expect(() => r.u8()).toThrow(RangeError);
  });

  it('reset() lets the writer be reused', () => {
    const w = new BinaryWriter();
    w.u32(1);
    w.reset();
    w.u8(7);
    expect([...w.finish()]).toEqual([7]);
  });

  it('exposes PROTOCOL_VERSION 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
