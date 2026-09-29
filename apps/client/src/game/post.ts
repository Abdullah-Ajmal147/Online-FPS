import * as THREE from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import {
  Fn,
  Loop,
  dot,
  exp,
  float,
  getViewPosition,
  hash,
  max,
  pow,
  vec2,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  saturation,
  screenCoordinate,
  screenUV,
  smoothstep,
  time,
  uniform,
  vec4,
} from 'three/tsl';

/**
 * The look of a scene after it is lit: contrast, colour and a lens feel. Values per map mood
 * (lighting preset); see LOOKS in game.ts.
 */
export interface Grade {
  /** 1 = as rendered; above 1 = deeper shadows and brighter highlights. */
  contrast: number;
  /** 1 = as rendered. */
  saturation: number;
  /** Added to the dark tones and to the bright tones (display space, small values). */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** 0 = none; how much the corners darken. */
  vignette: number;
  /** 0 = none; film grain strength. */
  grain: number;
}

/**
 * Atmosphere per map mood: haze that lies low over the ground and thickens with distance,
 * glowing toward the sun; and sun shafts (High) where the sky shows between buildings.
 */
export interface Haze {
  /** Haze colour away from the sun, and its colour looking into the sun (linear RGB). */
  color: [number, number, number];
  sunColor: [number, number, number];
  /** How fast it builds with distance (per metre), and how quickly it thins with height (m). */
  density: number;
  falloff: number;
  /** Most it can cover (0–1): distant buildings stay readable. */
  max: number;
  /** Strength of the sun shafts (High). */
  shafts: number;
}

/**
 * Medium/High: the scene is drawn into a texture, then graded (tone mapping, contrast,
 * split-toning, vignette, grain) into the screen. High adds ambient occlusion (corners and
 * contact shadows, half resolution, normals from the same pass: no second scene render) and
 * bloom. Low draws straight to the screen and skips all of it.
 */
export class Post {
  private readonly pipeline: THREE.RenderPipeline;
  private readonly u = {
    contrast: uniform(1),
    saturation: uniform(1),
    shadowTint: uniform(new THREE.Vector3()),
    highlightTint: uniform(new THREE.Vector3()),
    vignette: uniform(0),
    grain: uniform(0),
    /** 0–1: hurt / low health drains the colour (set every frame by the game). */
    stress: uniform(0),
    hazeColor: uniform(new THREE.Vector3(0.6, 0.65, 0.7)),
    hazeSunColor: uniform(new THREE.Vector3(1, 0.9, 0.7)),
    hazeDensity: uniform(0),
    hazeFalloff: uniform(6),
    hazeMax: uniform(0.5),
    shafts: uniform(0),
    /** Direction to the sun (world), and where it is on screen (uv) and how much it faces us. */
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunUv: uniform(new THREE.Vector2(0.5, 0.5)),
    sunFacing: uniform(0),
  };
  private readonly camera: THREE.Camera;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    readonly quality: { ambientOcclusion: boolean; bloom: boolean; sunShafts: boolean },
  ) {
    this.camera = camera;
    const u = this.u;
    const scenePass = pass(scene, camera);
    let color: THREE.Node<'vec4'> = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    if (quality.ambientOcclusion) {
      scenePass.setMRT(mrt({ output, normal: normalView }));
      const aoPass = ao(
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('normal'),
        camera,
      );
      aoPass.resolutionScale = 0.5;
      aoPass.samples.value = 8;
      aoPass.radius.value = 0.6;
      aoPass.distanceFallOff.value = 0.5;
      // Darken by the occlusion, but never to black: it stands in for blocked sky light.
      const occlusion = aoPass.getTextureNode().sample(screenUV).r;
      color = vec4(color.rgb.mul(mix(float(0.35), float(1), occlusion)), color.a);
    }
    // Ground haze (linear light, before tone mapping): from the depth, where the pixel is in
    // the world; haze builds with distance and fades with height above the ground, and turns
    // warm toward the sun. The sky (nothing drawn: depth 1) is left as the sky draws itself.
    const projInverse = uniform(camera.projectionMatrixInverse);
    const camWorld = uniform(camera.matrixWorld);
    const depth = depthTex.sample(screenUV).r;
    const viewPos = getViewPosition(screenUV, depth, projInverse);
    const worldPos = camWorld.mul(vec4(viewPos, 1)).xyz;
    const camPos = camWorld.mul(vec4(0, 0, 0, 1)).xyz;
    const ray = worldPos.sub(camPos);
    const dist = ray.length();
    const rayDir = ray.div(max(dist, 0.001));
    const low = exp(max(worldPos.y, 0).negate().div(u.hazeFalloff));
    const amount = float(1)
      .sub(exp(dist.mul(u.hazeDensity).negate()))
      .mul(low)
      .min(u.hazeMax)
      .mul(depth.lessThan(0.99999).select(float(1), float(0)));
    const glow = pow(max(dot(rayDir, u.sunDir), 0), 8);
    const hazeCol = mix(u.hazeColor, u.hazeSunColor, glow);
    color = vec4(mix(color.rgb, hazeCol, amount), color.a);

    // Sun shafts (High): the sky around the sun, blurred outward from the sun's spot on screen,
    // so light streams between buildings and through gaps (only when the sun is ahead).
    if (quality.sunShafts) {
      const shafts = Fn(() => {
        const sum = float(0).toVar();
        const uv = screenUV.toVar();
        const step = u.sunUv.sub(screenUV).mul(1 / 24);
        Loop(24, () => {
          uv.addAssign(step);
          // Only open sky close to the sun gives off shafts (not the whole sky).
          const sky = depthTex.sample(uv).r.greaterThanEqual(0.99999).select(float(1), float(0));
          const nearSun = float(1)
            .sub(uv.sub(u.sunUv).mul(vec2(1.6, 1)).length().div(0.22))
            .max(0);
          sum.addAssign(sky.mul(nearSun.mul(nearSun)));
        });
        return sum.div(24);
      })();
      const near = float(1).sub(screenUV.sub(u.sunUv).mul(vec2(1.6, 1)).length().min(1));
      const light = shafts.mul(near).mul(u.sunFacing).mul(u.shafts).min(0.22);
      color = vec4(color.rgb.add(u.hazeSunColor.mul(light)), color.a);
    }
    if (quality.bloom) {
      // Bloom from what is in the world (muzzle flashes, tracers, sparks, glints), barely from
      // the sky: the bright sky around the sun flooded the whole screen when you faced it.
      const skyShare = depth.lessThan(0.99999).select(float(1), float(0.08));
      color = color.add(bloom(vec4(color.rgb.mul(skyShare), color.a), 0.22, 0.2, 3));
    }

    // Grade in display space (after tone mapping), where "contrast" means what it looks like.
    const display = renderOutput(color);
    let g = display.rgb.sub(0.5).mul(u.contrast).add(0.5);
    g = saturation(g, u.saturation.mul(float(1).sub(u.stress.mul(0.65))));
    const lum = luminance(g);
    g = g.add(mix(u.shadowTint, u.highlightTint, smoothstep(0.15, 0.85, lum)));
    const d = screenUV.sub(0.5).length();
    g = g.mul(float(1).sub(u.vignette.mul(smoothstep(0.3, 0.8, d))));
    // Per-pixel noise, a new pattern each frame (a hash of the pixel index, not of UVs:
    // UV-based seeds showed as streaks).
    const pixel = screenCoordinate.x.floor().add(screenCoordinate.y.floor().mul(4099));
    const noise = hash(pixel.add(time.mul(60).floor().mul(7919)));
    g = g.add(noise.sub(0.5).mul(u.grain));
    this.pipeline = new THREE.RenderPipeline(renderer, vec4(g.clamp(0, 1), display.a));
    this.pipeline.outputColorTransform = false; // renderOutput above already did it
  }

  setGrade(grade: Grade): void {
    this.u.contrast.value = grade.contrast;
    this.u.saturation.value = grade.saturation;
    this.u.shadowTint.value.set(...grade.shadowTint);
    this.u.highlightTint.value.set(...grade.highlightTint);
    this.u.vignette.value = grade.vignette;
    this.u.grain.value = grade.grain;
  }

  setHaze(h: Haze, sunDirection: THREE.Vector3): void {
    const u = this.u;
    u.hazeColor.value.set(...h.color);
    u.hazeSunColor.value.set(...h.sunColor);
    u.hazeDensity.value = h.density;
    u.hazeFalloff.value = h.falloff;
    u.hazeMax.value = h.max;
    u.shafts.value = h.shafts;
    u.sunDir.value.copy(sunDirection).normalize();
  }

  /** Every frame: where the sun is on screen (for the shafts). */
  updateSun(): void {
    const u = this.u;
    const cam = this.camera;
    sunPoint.copy(u.sunDir.value).multiplyScalar(1000).add(cam.getWorldPosition(camPoint));
    cam.getWorldDirection(camPoint);
    u.sunFacing.value = Math.max(0, camPoint.dot(u.sunDir.value)) ** 2;
    sunPoint.project(cam);
    u.sunUv.value.set(sunPoint.x * 0.5 + 0.5, 0.5 - sunPoint.y * 0.5);
  }

  setStress(v: number): void {
    this.u.stress.value = v;
  }

  render(): void {
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}

const sunPoint = new THREE.Vector3();
const camPoint = new THREE.Vector3();
