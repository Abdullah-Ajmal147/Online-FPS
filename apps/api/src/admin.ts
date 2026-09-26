import { timingSafeEqual } from 'node:crypto';
import { RateLimiter } from '@sentinel/auth';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Store } from './db.ts';

/**
 * Moderation (Phase 7 task 5): a small admin page on the API. Off unless
 * SENTINEL_ADMIN_PASSWORD (12+ characters) is set; HTTP Basic auth (user "admin") behind
 * Caddy's HTTPS; failed logins are rate-limited per IP.
 */
export function mountAdmin(
  app: Hono,
  store: Store,
  password: string | undefined,
  codeOf: (guestId: string) => string,
): void {
  if (!password || password.length < 12) return; // admin disabled: every /admin path is a 404
  const expected = Buffer.from(`admin:${password}`);
  const failures = new RateLimiter(10, 1 / 60);
  const ipOf = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

  app.use('/admin/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const given = header.startsWith('Basic ')
      ? Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8'))
      : Buffer.alloc(0);
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      if (!failures.take(ipOf(c))) return c.text('too many attempts', 429);
      c.header('WWW-Authenticate', 'Basic realm="Sentinel admin"');
      return c.text('authentication required', 401);
    }
    await next();
  });
  app.use('/admin', async (c, next) => {
    // Same check for the page itself.
    const header = c.req.header('authorization') ?? '';
    const given = header.startsWith('Basic ')
      ? Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8'))
      : Buffer.alloc(0);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      if (!failures.take(ipOf(c))) return c.text('too many attempts', 429);
      c.header('WWW-Authenticate', 'Basic realm="Sentinel admin"');
      return c.text('authentication required', 401);
    }
    await next();
  });

  app.get('/admin', (c) => c.html(ADMIN_PAGE));
  app.get('/admin/api/queue', (c) => c.json(store.moderationQueue()));
  app.get('/admin/api/players/:code', (c) => {
    const file = store.playerFile(c.req.param('code'));
    return file ? c.json(file) : c.json({ error: 'not found' }, 404);
  });
  app.get('/admin/api/matches/:id/log', (c) => {
    const id = c.req.param('id');
    const log = store.matchLog(id);
    if (!log) return c.json({ error: 'no log (older than 14 days?)' }, 404);
    // Which in-match player is the one we're looking at (?code=…), and everyone's team.
    const summary = store.matchSummary(id);
    const code = c.req.query('code');
    const players = (summary?.players ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      focus: !!code && !!p.guestId && codeOf(p.guestId) === code,
    }));
    return c.json({ log, players });
  });
  const StatusSchema = z.object({ status: z.enum(['ok', 'shadow', 'banned']) });
  app.post('/admin/api/players/:code/status', async (c) => {
    const parsed = StatusSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad status' }, 400);
    return store.setStatus(c.req.param('code'), parsed.data.status)
      ? c.json({ ok: true })
      : c.json({ error: 'no such player' }, 404);
  });
}

const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sentinel admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;background:#0b0e0d;color:#dfe6e1;font:14px/1.5 system-ui,sans-serif}
  header{padding:14px 24px;border-bottom:1px solid #28312d;font:600 18px 'Bahnschrift','Arial Narrow',sans-serif;letter-spacing:.12em;text-transform:uppercase}
  header b{color:#f0b429}
  main{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:20px;padding:20px 24px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1c2320}
  th{color:#86938d;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  tr.pick{cursor:pointer} tr.pick:hover{background:#151b19}
  .tag{display:inline-block;padding:1px 6px;margin:1px;border:1px solid #3b4843;font-size:11px}
  .tag.flag{border-color:#c98f12;color:#f0b429}
  .st-shadow{color:#b48cff}.st-banned{color:#e5534b}.st-ok{color:#5cc27d}
  button{padding:6px 12px;margin-right:6px;border:1px solid #3b4843;background:#151b19;color:#dfe6e1;cursor:pointer}
  button:hover{border-color:#f0b429}
  h2{font:600 14px 'Bahnschrift','Arial Narrow',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#f0b429;margin:18px 0 6px}
  canvas{background:#111614;border:1px solid #28312d;max-width:100%}
  .muted{color:#86938d}
</style></head><body>
<header>Sentinel <b>Strike</b> · moderation</header>
<main>
  <section><h2>Queue: reported or flagged</h2><table id="queue"><thead><tr><th>Player</th><th>Status</th><th>Reports</th><th>Flagged</th></tr></thead><tbody></tbody></table></section>
  <section id="file"><p class="muted">Pick a player on the left.</p></section>
</main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';');
async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(r.status); return r.json(); }
async function loadQueue() {
  const rows = await j(base + '/queue');
  $('#queue tbody').innerHTML = rows.map((r) => '<tr class="pick" data-code="' + esc(r.code) + '"><td>' + esc(r.name ?? r.code) + '<br><small class="muted">' + esc(r.code) + '</small></td><td class="st-' + esc(r.status) + '">' + esc(r.status) + '</td><td>' + r.reports + '</td><td>' + r.flaggedMatches + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">Nothing to review.</td></tr>';
  document.querySelectorAll('tr.pick').forEach((tr) => tr.onclick = () => openPlayer(tr.dataset.code));
}
const base = location.pathname.replace(/\\/admin\\/?$/, '') + '/admin/api';
async function openPlayer(code) {
  const f = await j(base + '/players/' + code);
  const p = f.profile;
  $('#file').innerHTML =
    '<h2>' + esc(p?.name ?? code) + ' <span class="st-' + esc(p?.status ?? 'ok') + '">(' + esc(p?.status ?? 'no profile') + ')</span></h2>' +
    (p ? '<p>' + p.matches + ' matches · ' + p.kills + ' kills / ' + p.deaths + ' deaths · K/D ' + (p.kills / Math.max(1, p.deaths)).toFixed(2) + '</p>' : '') +
    '<p><button data-s="ok">Clear (ok)</button><button data-s="shadow">Shadow-ban</button><button data-s="banned">Ban</button></p>' +
    '<h2>Anomaly flags</h2><table><tr><th>When</th><th>Flags</th><th>Aim</th><th></th></tr>' +
    f.flags.map((x) => '<tr><td>' + new Date(x.at).toLocaleString() + '</td><td>' + x.flags.map((t) => '<span class="tag flag">' + esc(t) + '</span>').join('') + '</td><td><small>' + esc(JSON.stringify(x.aim)) + '</small></td><td><button data-log="' + esc(x.matchId) + '">Replay</button></td></tr>').join('') + '</table>' +
    '<h2>Reports</h2><table><tr><th>When</th><th>Reason</th><th></th></tr>' +
    f.reports.map((r) => '<tr><td>' + new Date(r.at).toLocaleString() + '</td><td><span class="tag">' + esc(r.reason) + '</span></td><td>' + (r.matchId ? '<button data-log="' + esc(r.matchId) + '">Replay</button>' : '') + '</td></tr>').join('') + '</table>' +
    '<div id="replay"></div>';
  $('#file').querySelectorAll('button[data-s]').forEach((b) => b.onclick = async () => {
    await j(base + '/players/' + code + '/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: b.dataset.s }) });
    openPlayer(code); loadQueue();
  });
  $('#file').querySelectorAll('button[data-log]').forEach((b) => b.onclick = () => replay(b.dataset.log, code));
}
async function replay(matchId, code) {
  const { log, players } = await j(base + '/matches/' + matchId + '/log?code=' + code).catch(() => ({}));
  if (!log) { $('#replay').innerHTML = '<p class="muted">No log (older than 14 days?)</p>'; return; }
  const W = 560, H = 560, scale = 7, cx = W / 2, cy = H / 2;
  $('#replay').innerHTML = '<h2>Replay · positions each second, ✕ kills (focus player highlighted)</h2><canvas width="' + W + '" height="' + H + '"></canvas><p><input type="range" min="0" max="' + (log.samples.length - 1) + '" value="' + (log.samples.length - 1) + '" style="width:' + W + 'px"></p>';
  const ctx = $('#replay canvas').getContext('2d');
  const byId = new Map(players.map((p) => [p.id, p]));
  const color = (id) => { const p = byId.get(id); return p?.focus ? '#f0b429' : p?.team === 1 ? '#ff6b35' : '#4aa3ff'; };
  const draw = (upto) => {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i <= upto; i++) {
      const [, ps] = log.samples[i];
      for (const [id, x, z] of ps) {
        ctx.fillStyle = color(id); ctx.globalAlpha = i === upto ? 1 : 0.18;
        ctx.fillRect(cx + x * scale - (i === upto ? 3 : 1), cy + z * scale - (i === upto ? 3 : 1), i === upto ? 6 : 2, i === upto ? 6 : 2);
      }
    }
    ctx.globalAlpha = 1;
    const t = log.samples[upto]?.[0] ?? 0;
    for (const [kt, killer, , , , kx, kz, vx, vz] of log.kills) {
      if (kt > t) continue;
      ctx.strokeStyle = byId.get(killer)?.focus ? '#f0b429' : '#86938d';
      ctx.beginPath(); ctx.moveTo(cx + kx * scale, cy + kz * scale); ctx.lineTo(cx + vx * scale, cy + vz * scale); ctx.stroke();
      ctx.fillStyle = '#e5534b'; ctx.fillText('✕', cx + vx * scale - 4, cy + vz * scale + 4);
    }
  };
  const slider = $('#replay input');
  slider.oninput = () => draw(Number(slider.value));
  draw(log.samples.length - 1);
}
loadQueue();
</script></body></html>`;
