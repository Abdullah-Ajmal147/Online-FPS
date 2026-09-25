import { describe, expect, it } from 'vitest';
import { app } from './app.ts';

describe('api', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'api' });
  });
});
