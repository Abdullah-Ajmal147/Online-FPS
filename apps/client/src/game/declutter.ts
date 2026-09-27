/** A label on screen: centre-bottom anchor (x, y) in pixels, size, and distance from the eye. */
export interface Label {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/**
 * Keep screen labels (name tags) from covering each other: nearest first, each later label
 * moves up by whole label heights (plus a gap) until it clears every label already placed.
 * Returns the upward shift in pixels for each label, in the input order.
 */
export function declutter(labels: readonly Label[], gap = 2, maxSteps = 6): number[] {
  const order = labels.map((_, i) => i).sort((a, b) => labels[a]!.depth - labels[b]!.depth);
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const shift = new Array<number>(labels.length).fill(0);
  for (const i of order) {
    const l = labels[i]!;
    let dy = 0;
    for (let step = 0; step <= maxSteps; step++) {
      const box = {
        left: l.x - l.w / 2,
        right: l.x + l.w / 2,
        top: l.y - l.h - dy,
        bottom: l.y - dy,
      };
      const hit = placed.some(
        (p) => box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top,
      );
      if (!hit || step === maxSteps) {
        placed.push(box);
        break;
      }
      dy += l.h + gap;
    }
    shift[i] = dy;
  }
  return shift;
}
