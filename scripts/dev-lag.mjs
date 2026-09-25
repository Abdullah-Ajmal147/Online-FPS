// `pnpm dev:lag [--preset good|normal|bad]` — runs `pnpm dev` with SENTINEL_LAG set for the server.
// Presets are defined in docs/NETCODE.md; the server-side fake-lag layer is Phase 1, task 8.
import { spawn } from 'node:child_process';

const presets = ['good', 'normal', 'bad'];
const argv = process.argv.slice(2).filter((a) => a !== '--');
const i = argv.indexOf('--preset');
const preset = i === -1 ? 'normal' : argv[i + 1];

if (!preset || !presets.includes(preset)) {
  console.error(`unknown preset "${preset}". Use one of: ${presets.join(', ')}`);
  process.exit(1);
}

const child = spawn('pnpm', ['dev'], {
  stdio: 'inherit',
  env: { ...process.env, SENTINEL_LAG: preset },
});
child.on('exit', (code) => process.exit(code ?? 0));
