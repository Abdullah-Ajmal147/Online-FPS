import { describe, expect, it } from 'vitest';
import { setStatus, subscribe, type ClientStatus } from './store.ts';

describe('store.subscribe', () => {
  it('delivers the current status to late subscribers (updates before subscribe are not lost)', () => {
    setStatus({ net: { state: 'connected', text: 'connected, protocol v1' } });

    const seen: ClientStatus[] = [];
    const unsubscribe = subscribe((s) => seen.push(s));
    expect(seen.at(-1)?.net.text).toBe('connected, protocol v1');

    setStatus({ backend: 'WebGL 2' });
    expect(seen.at(-1)?.backend).toBe('WebGL 2');

    unsubscribe();
    setStatus({ backend: 'WebGPU' });
    expect(seen.at(-1)?.backend).toBe('WebGL 2');
  });
});
