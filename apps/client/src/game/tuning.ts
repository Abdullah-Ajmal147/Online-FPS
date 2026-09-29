import { feel, type Feel, type Weapon } from '@sentinel/content';
import type { Grade } from './post.ts';

/**
 * Live tuning (F1 panel): the game reads these every frame, the panel writes them.
 *
 * - `feel` is the content's feel.json, edited in place (the panel can copy it back as JSON).
 * - `grade` / `exposure`: null = the map's own look; set = an override while tuning.
 * - `stats`: what the frame loop measured, for the panel's graph and counters.
 */
export const tuning: {
  feel: Feel;
  grade: Grade | null;
  exposure: number | null;
  /** Bumped on every panel change, so the game re-applies grade/exposure only then. */
  version: number;
  /** The weapon in our hands (its kick is the one the panel edits). */
  weapon: Pick<Weapon, 'id' | 'class'>;
  /** The map's grade, so the panel starts from what is on screen. */
  mapGrade: Grade | null;
  mapExposure: number;
} = {
  feel,
  grade: null,
  exposure: null,
  version: 0,
  weapon: { id: 'kestrel-ar', class: 'rifle' },
  mapGrade: null,
  mapExposure: 0.58,
};

/** Frame times (ms), newest at `head - 1`, and renderer counters of the last frame. */
export const devStats = {
  frames: new Float32Array(240),
  head: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  renderScale: 1,
  backend: '',

  push(ms: number): void {
    this.frames[this.head] = ms;
    this.head = (this.head + 1) % this.frames.length;
  },
};
