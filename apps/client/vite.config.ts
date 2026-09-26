import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

/**
 * Link previews need absolute URLs: SITE_URL (e.g. https://play.example.com) at build time.
 * Without it the image path stays relative (fine locally; previews just show no image).
 */
const siteUrl = (process.env.SITE_URL ?? '').replace(/\/$/, '');
const siteUrlPlugin = {
  name: 'site-url',
  transformIndexHtml: (html: string) => html.replaceAll('%SITE_URL%', siteUrl),
};

export default defineConfig(({ mode }) => ({
  // Portal build (`--mode crazygames`): served from their CDN under a sub-path, so asset URLs
  // are relative, and the output goes to its own folder. The game server and API URLs must
  // then be absolute (VITE_SERVER_URL or VITE_REGIONS, VITE_API_URL): see docs/RUNBOOK.md.
  ...(mode === 'crazygames' && { base: './' }),
  define:
    mode === 'crazygames' ? { 'import.meta.env.VITE_PLATFORM': JSON.stringify('crazygames') } : {},
  plugins: [preact(), siteUrlPlugin],
  server: { port: 5173, strictPort: true },
  // Pre-bundle heavy dependencies at startup. Otherwise Vite discovers them on first page load
  // and reloads the page mid-session, which also made fresh-cache e2e runs flaky.
  optimizeDeps: {
    include: [
      'three/webgpu',
      'three/addons/geometries/ConvexGeometry.js',
      '@colyseus/sdk',
      '@dimforge/rapier3d-compat',
      'preact',
      'preact/hooks',
      'zod',
    ],
  },
  build: { target: 'es2023', outDir: mode === 'crazygames' ? 'dist-crazygames' : 'dist' },
}));
