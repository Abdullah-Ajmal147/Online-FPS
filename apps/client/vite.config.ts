import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
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
