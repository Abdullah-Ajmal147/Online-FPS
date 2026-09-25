import { pitchFromRadians, yawFromRadians, type PlayerInput } from '@sentinel/shared';
import type { Settings } from '../settings.ts';
import { buttonsFromKeys } from './keys.ts';
import { applyLook, type Look } from './look.ts';

/**
 * Collects keyboard + mouse input. Mouse look needs pointer lock (click the game);
 * raw, unaccelerated movement is requested where the browser supports it.
 */
export class InputCapture {
  look: Look;
  locked = false;
  private held = new Set<string>();
  private sprintLatched = false;
  private listeners: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private settings: () => Settings,
    initialYaw: number,
    private onLockChange: (locked: boolean) => void,
  ) {
    this.look = { yaw: initialYaw, pitch: 0 };
    this.on(document, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(document, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => this.releaseAll());
    this.on(document, 'mousemove', (e) => {
      if (!this.locked) return;
      const m = e as MouseEvent;
      this.look = applyLook(this.look, m.movementX, m.movementY, this.settings().sensitivity);
    });
    this.on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
      this.onLockChange(this.locked);
    });
  }

  async requestLock(): Promise<void> {
    try {
      // Raw input: no OS mouse acceleration. Not supported everywhere (e.g. some Safari/Firefox).
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.canvas.requestPointerLock();
      } catch (err) {
        console.warn('[input] pointer lock failed:', err);
      }
    }
  }

  /** The input for the next simulation tick, already in the protocol's 16-bit angles. */
  sample(): PlayerInput {
    const s = this.settings();
    const sprintHeld = this.held.has(s.bindings.sprint);
    return {
      buttons: buttonsFromKeys(
        this.held,
        s.bindings,
        s.toggleSprint ? this.sprintLatched : sprintHeld,
      ),
      yaw: yawFromRadians(this.look.yaw),
      pitch: pitchFromRadians(this.look.pitch),
    };
  }

  dispose(): void {
    for (const off of this.listeners) off();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement) return;
    const s = this.settings();
    const bound = Object.values(s.bindings).includes(e.code);
    if (!bound) return;
    // Keep the page from scrolling on Space etc. while playing.
    if (this.locked) e.preventDefault();
    if (down) {
      if (e.code === s.bindings.sprint && s.toggleSprint && !e.repeat) {
        this.sprintLatched = !this.sprintLatched;
      }
      this.held.add(e.code);
    } else {
      this.held.delete(e.code);
    }
  }

  private releaseAll(): void {
    this.held.clear();
    this.sprintLatched = false;
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
