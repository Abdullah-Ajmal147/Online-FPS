import { Button, pitchFromRadians, yawFromRadians, type PlayerInput } from '@sentinel/shared';
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
  /** Mouse buttons: left = fire, right = aim down sights. */
  private mouseButtons = 0;
  /** Selected weapon slot (keys 1/2, mouse wheel). */
  weaponSlot: 0 | 1 = 0;
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
    if (import.meta.env.DEV) {
      // Dev/test only (stripped from production builds): lets Playwright aim and shoot
      // without pointer lock, which headless browsers can't grant.
      (window as unknown as { __sentinelInput?: unknown }).__sentinelInput = {
        setLook: (yaw: number, pitch: number) => (this.look = { yaw, pitch }),
        setMouse: (fire: boolean, aim: boolean) =>
          (this.mouseButtons = (fire ? Button.Fire : 0) | (aim ? Button.Aim : 0)),
      };
    }
    this.on(document, 'mousedown', (e) => {
      if (!this.locked) return;
      const b = (e as MouseEvent).button;
      if (b === 0) this.mouseButtons |= Button.Fire;
      if (b === 2) this.mouseButtons |= Button.Aim;
    });
    this.on(document, 'mouseup', (e) => {
      const b = (e as MouseEvent).button;
      if (b === 0) this.mouseButtons &= ~Button.Fire;
      if (b === 2) this.mouseButtons &= ~Button.Aim;
    });
    this.on(document, 'contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    this.on(document, 'wheel', (e) => {
      if (!this.locked || (e as WheelEvent).deltaY === 0) return;
      this.weaponSlot = this.weaponSlot === 0 ? 1 : 0;
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
      buttons:
        buttonsFromKeys(this.held, s.bindings, s.toggleSprint ? this.sprintLatched : sprintHeld) |
        this.mouseButtons,
      yaw: yawFromRadians(this.look.yaw),
      pitch: pitchFromRadians(this.look.pitch),
      weaponSlot: this.weaponSlot,
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
      if (e.code === s.bindings.primary) this.weaponSlot = 0;
      if (e.code === s.bindings.secondary) this.weaponSlot = 1;
      this.held.add(e.code);
    } else {
      this.held.delete(e.code);
    }
  }

  private releaseAll(): void {
    this.held.clear();
    this.sprintLatched = false;
    this.mouseButtons = 0;
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
