import { describe, expect, it } from 'vitest';
import { Button } from '@sentinel/shared';
import {
  GUESS_FIRE_TICKS,
  InputQueue,
  MAX_QUEUED_INPUTS,
  MAX_REPEAT_TICKS,
  START_BUFFER,
} from './inputQueue.ts';

const input = (seq: number, buttons = seq) => ({
  seq,
  buttons,
  yaw: seq,
  pitch: 0,
  weaponSlot: 0,
  viewTick: seq,
});

function started(): InputQueue {
  const q = new InputQueue();
  for (let s = 1; s <= START_BUFFER; s++) q.push(input(s));
  return q;
}

describe('InputQueue', () => {
  it('waits for a small buffer before starting (player not simulated meanwhile)', () => {
    const q = new InputQueue();
    q.push(input(1));
    expect(q.next()).toBeNull();
    expect(q.lastProcessedSeq).toBe(0);
    q.push(input(2));
    expect(q.next()!.buttons).toBe(1);
    expect(q.lastProcessedSeq).toBe(1);
  });

  it('accepts any first seq as the baseline (client counted seqs offline before joining)', () => {
    const q = new InputQueue();
    q.push(input(5000));
    q.push(input(5001));
    expect(q.next()!.buttons).toBe(5000);
    q.push(input(5002 + 10_000)); // but later huge jumps are garbage
    q.push(input(5002));
    expect(q.depth).toBe(2);
  });

  it('applies inputs in seq order even if they arrive out of order', () => {
    const q = new InputQueue();
    q.push(input(3));
    q.push(input(1));
    q.push(input(2));
    expect([q.next(), q.next(), q.next()].map((i) => i!.buttons)).toEqual([1, 2, 3]);
  });

  it('drops duplicates and inputs already processed (redundant resends)', () => {
    const q = started();
    q.push(input(1));
    q.push(input(2));
    q.next();
    q.push(input(1)); // already processed
    q.push(input(2)); // still queued: duplicate
    q.push(input(3));
    expect(q.depth).toBe(2);
    expect([q.next(), q.next()].map((i) => i!.buttons)).toEqual([2, 3]);
  });

  it('repeats the last input when starved, without advancing lastProcessedSeq', () => {
    const q = started();
    q.next();
    q.next();
    const repeated = q.next();
    expect(repeated!.buttons).toBe(2);
    expect(q.lastProcessedSeq).toBe(2);
  });

  it('skips a lost seq when later inputs are available', () => {
    const q = started();
    q.next();
    q.next();
    q.push(input(4)); // 3 was lost, even with redundancy
    expect(q.next()!.buttons).toBe(4);
    expect(q.lastProcessedSeq).toBe(4);
    q.push(input(3)); // arrives too late
    expect(q.depth).toBe(0);
  });

  it('never gives more than one input per tick and caps the queue (no speed-up by flooding)', () => {
    const q = started();
    for (let s = 3; s < 100; s++) q.push(input(s));
    expect(q.depth).toBe(MAX_QUEUED_INPUTS);
    q.next();
    expect(q.depth).toBe(MAX_QUEUED_INPUTS - 1);
  });

  it('keeps a whole 0.25 s catch-up burst (15 inputs) on top of the normal queue', () => {
    const q = started();
    for (let s = 3; s < 3 + 15; s++) q.push(input(s));
    expect(q.depth).toBe(START_BUFFER + 15);
  });

  it('recovers within a few ticks after a 250 ms hitch + burst (no double movement, no lingering lag)', () => {
    const q = new InputQueue();
    let seq = 0;
    const send = () => q.push(input(++seq, Button.Forward));
    // Steady state: one input arrives per tick, queue ~2 deep.
    send();
    send();
    for (let t = 0; t < 60; t++) {
      send();
      q.next();
    }
    // Hitch: 15 ticks with nothing arriving; the server guesses.
    for (let t = 0; t < 15; t++) q.next();
    // Burst: the 15 late inputs arrive at once, then steady again.
    for (let i = 0; i < 15; i++) send();
    let ticks = 0;
    while (q.depth > 3 && ticks < 100) {
      send();
      q.next();
      ticks++;
    }
    expect(ticks).toBeLessThanOrEqual(30); // back to normal within 0.5 s
  });

  it('keeps jump/crouch presses from inputs dropped while catching up', () => {
    const q = started();
    q.next();
    q.next(); // seq 2
    q.next(); // starved ×2 → debt 2
    q.next();
    q.push(input(3, Button.Forward | Button.Jump)); // dropped (debt)
    q.push(input(4, Button.Forward)); // dropped (debt)
    q.push(input(5, Button.Forward));
    const next = q.next()!;
    expect(q.lastProcessedSeq).toBe(5);
    expect(next.buttons & Button.Jump).toBeTruthy();
  });

  it('stops repeating a silent client after 250 ms (tabbed out while running)', () => {
    const q = new InputQueue();
    q.push(input(1, Button.Forward | Button.Sprint));
    q.push(input(2, Button.Forward | Button.Sprint));
    q.next();
    q.next();
    for (let t = 0; t < MAX_REPEAT_TICKS; t++)
      expect(q.next()!.buttons).toBe(Button.Forward | Button.Sprint);
    const idle = q.next()!;
    expect(idle.buttons).toBe(0);
    expect(idle.yaw).toBe(2); // keeps facing the same way
  });

  it('ignores garbage seqs once started', () => {
    const q = started();
    q.next(); // seq 1 processed: baseline set
    q.push(input(1_000_000));
    q.push({ ...input(5), seq: 5.5 });
    expect(q.depth).toBe(START_BUFFER - 1);
  });
});

describe('InputQueue: guessed ticks', () => {
  it('repeats movement, keeps a held trigger only briefly, never reloads, when inputs are missing', () => {
    const q = new InputQueue();
    q.push(input(1, Button.Forward | Button.Fire | Button.Reload));
    q.push(input(2, Button.Forward | Button.Fire | Button.Reload));
    q.next();
    q.next();
    for (let t = 1; t <= GUESS_FIRE_TICKS; t++) {
      const guessed = q.next()!;
      expect(guessed.buttons & Button.Fire).toBeTruthy(); // short jitter gap: keep firing
      expect(guessed.buttons & Button.Reload).toBe(0);
    }
    const later = q.next()!;
    expect(later.buttons & Button.Forward).toBeTruthy();
    expect(later.buttons & Button.Fire).toBe(0); // longer gap: stop firing on a guess
  });
});

describe('InputQueue: hostile seqs', () => {
  it('ignores seqs beyond u32, even as the first (baseline) input', () => {
    const q = new InputQueue();
    q.push({ seq: 2 ** 32, buttons: 1, yaw: 0, pitch: 0, weaponSlot: 0, viewTick: 0 });
    q.push({ seq: 2 ** 32 + 1, buttons: 1, yaw: 0, pitch: 0, weaponSlot: 0, viewTick: 0 });
    expect(q.depth).toBe(0);
  });
});
