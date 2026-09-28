import * as THREE from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import {
  float,
  hash,
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
  };

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    readonly quality: { ambientOcclusion: boolean; bloom: boolean },
  ) {
    const scenePass = pass(scene, camera);
    let color: THREE.Node<'vec4'> = scenePass.getTextureNode('output');
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
    if (quality.bloom) color = color.add(bloom(color, 0.22, 0.2, 3));

    // Grade in display space (after tone mapping), where "contrast" means what it looks like.
    const display = renderOutput(color);
    const u = this.u;
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
