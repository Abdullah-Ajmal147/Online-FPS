import { Hono } from 'hono';
import { cors } from 'hono/cors';

/** The API app, separate from the Node listener so tests can call it directly. */
export const app = new Hono();

app.use('*', cors());

app.get('/healthz', (c) => c.json({ ok: true, service: 'api' }));
