import * as THREE from 'three/webgpu';

/**
 * Phase 0 scene: a spinning cube. WebGPURenderer falls back to WebGL 2 automatically
 * when WebGPU is unavailable; we report which backend actually started.
 */
export async function startRenderer(canvas: HTMLCanvasElement): Promise<'WebGPU' | 'WebGL 2'> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();

  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  console.info(`[renderer] backend: ${backend}`);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 3);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x2f81f7, roughness: 0.4, metalness: 0.1 }),
  );
  scene.add(cube);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 4, 5);
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Rendering is presentation only, so wall-clock time is fine here (not in packages/shared).
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = timer.getDelta();
    cube.rotation.x += dt * 0.6;
    cube.rotation.y += dt * 0.9;
    renderer.render(scene, camera);
  });

  return backend;
}
