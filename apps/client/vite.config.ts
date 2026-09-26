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

export default defineConfig({
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
  build: { target: 'es2023' },
});
