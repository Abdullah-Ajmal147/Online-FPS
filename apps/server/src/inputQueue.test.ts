import { describe, expect, it } from 'vitest';
import { InputQueue, MAX_QUEUED_INPUTS, START_BUFFER } from './inputQueue.ts';

const input = (seq: number, buttons = seq) => ({ seq, buttons, yaw: seq, pitch: 0, weaponSlot: 0 });

function started(): InputQueue {
  const q = new InputQueue();
  for (let s = 1; s <= START_BUFFER; s++) q.push(input(s));
  return q;
}

describe('InputQueue', () => {
  it('waits for a small buffer before starting, repeating idle input meanwhile', () => {
    const q = new InputQueue();
    q.push(input(1));
    expect(q.next().buttons).toBe(0);
    expect(q.lastProcessedSeq).toBe(0);
    q.push(input(2));
    expect(q.next().buttons).toBe(1);
    expect(q.lastProcessedSeq).toBe(1);
  });

  it('applies inputs in seq order even if they arrive out of order', () => {
    const q = new InputQueue();
    q.push(input(3));
    q.push(input(1));
    q.push(input(2));
    expect([q.next(), q.next(), q.next()].map((i) => i.buttons)).toEqual([1, 2, 3]);
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
    expect([q.next(), q.next()].map((i) => i.buttons)).toEqual([2, 3]);
  });

  it('repeats the last input when starved, without advancing lastProcessedSeq', () => {
    const q = started();
    q.next();
    q.next();
    const repeated = q.next();
    expect(repeated.buttons).toBe(2);
    expect(q.lastProcessedSeq).toBe(2);
  });

  it('skips a lost seq when later inputs are available', () => {
    const q = started();
    q.next();
    q.next();
    q.push(input(4)); // 3 was lost, even with redundancy
    expect(q.next().buttons).toBe(4);
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

  it('ignores garbage seqs', () => {
    const q = started();
    q.push(input(1_000_000));
    q.push({ ...input(5), seq: 5.5 });
    expect(q.depth).toBe(START_BUFFER);
  });
});
