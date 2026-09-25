import * as THREE from 'three/webgpu';
import { maps } from '@sentinel/content';
import { expandMap } from '@sentinel/shared';
import { buildMapMeshes } from './map.ts';

/**
 * Phase 1, task 1: show the greybox map from a slowly orbiting overview camera.
 * The first-person camera replaces this in task 4.
 * WebGPURenderer falls back to WebGL 2 automatically; we report which backend started.
 */
export async function startRenderer(canvas: HTMLCanvasElement): Promise<'WebGPU' | 'WebGL 2'> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  await renderer.init();

  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  console.info(`[renderer] backend: ${backend}`);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb6c9);
  scene.fog = new THREE.Fog(0x9fb6c9, 60, 140);

  const map = maps.greybox!;
  scene.add(buildMapMeshes(expandMap(map)));

  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x3a3f47, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(20, 40, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, far: 100 });
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Rendering is presentation only, so wall-clock time is fine here (not in packages/shared).
  const timer = new THREE.Timer();
  let angle = Math.PI / 4;
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    angle += timer.getDelta() * 0.08;
    camera.position.set(Math.cos(angle) * 45, 32, Math.sin(angle) * 45);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  });

  return backend;
}
