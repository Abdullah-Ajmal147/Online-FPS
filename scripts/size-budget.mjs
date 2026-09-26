// Download-size budget for the browser client (Phase 5, ROADMAP performance budgets).
// Run after `pnpm build` (or build:crazygames): fails (exit 1) if apps/client/dist breaks a limit.
//   first download < 15 MB · everything < 50 MB · < 1,500 files · no single file > 8 MB
// Everything in dist counts as "first download" until assets are streamed lazily.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const MB = 1024 * 1024;
const BUDGET = { firstDownload: 15 * MB, total: 50 * MB, files: 1500, singleFile: 8 * MB };
// Folder under apps/client (default dist; `node scripts/size-budget.mjs dist-crazygames`).
const dist = fileURLToPath(
  new URL(`../apps/client/${process.argv[2] ?? 'dist'}/`, import.meta.url),
);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let files;
try {
  files = walk(dist);
} catch {
  console.error(`no build found in ${dist} — run \`pnpm build\` first`);
  process.exit(1);
}
const rows = files
  .map((f) => ({
    file: relative(dist, f),
    bytes: statSync(f).size,
    gzip: gzipSync(readFileSync(f)).length,
  }))
  .sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((n, r) => n + r.bytes, 0);
const gzip = rows.reduce((n, r) => n + r.gzip, 0);
const fmt = (b) => `${(b / MB).toFixed(2)} MB`;

for (const r of rows.slice(0, 8))
  console.log(`${fmt(r.bytes).padStart(10)}  ${fmt(r.gzip).padStart(10)} gz  ${r.file}`);
console.log(`total ${fmt(total)} (${fmt(gzip)} gzipped) in ${rows.length} files`);

const problems = [];
if (total > BUDGET.firstDownload)
  problems.push(`first download ${fmt(total)} > ${fmt(BUDGET.firstDownload)}`);
if (total > BUDGET.total) problems.push(`total ${fmt(total)} > ${fmt(BUDGET.total)}`);
if (rows.length > BUDGET.files) problems.push(`${rows.length} files > ${BUDGET.files}`);
for (const r of rows)
  if (r.bytes > BUDGET.singleFile)
    problems.push(`${r.file} is ${fmt(r.bytes)} > ${fmt(BUDGET.singleFile)}`);
if (problems.length) {
  console.error('SIZE BUDGET BROKEN:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('size budget OK');
