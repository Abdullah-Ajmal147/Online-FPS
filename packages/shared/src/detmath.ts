/**
 * Deterministic trigonometry for the simulation.
 *
 * Math.sin/Math.cos are allowed to differ in the last bit between JS engines (V8 on the
 * server, SpiderMonkey/JavaScriptCore in some browsers). One differing bit can grow into a
 * prediction error, so the simulation uses this polynomial instead: it only uses + and *,
 * which IEEE-754 defines exactly, so every engine gets the same result.
 */

/** Angles in the simulation are 16-bit: 65536 steps per full turn. */
export const ANGLE_STEPS = 65536;
const QUARTER_STEPS = 16384;
const RADIANS_PER_STEP = Math.PI / 2 / QUARTER_STEPS;

/** Taylor series for sin/cos on [0, π/2]; terms up to x^17 give < 1e-13 error there. */
function sinPoly(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 *
                    (1 / 362880 +
                      x2 *
                        (-1 / 39916800 +
                          x2 *
                            (1 / 6227020800 +
                              x2 * (-1 / 1307674368000 + x2 / 355687428096000))))))))
  );
}

function cosPoly(x: number): number {
  const x2 = x * x;
  return (
    1 +
    x2 *
      (-1 / 2 +
        x2 *
          (1 / 24 +
            x2 *
              (-1 / 720 +
                x2 *
                  (1 / 40320 +
                    x2 *
                      (-1 / 3628800 +
                        x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 / 20922789888000)))))))
  );
}

/** [sin, cos] of a 16-bit angle (0..65535 = 0..2π). Quadrant reduction is exact integer math. */
export function detSinCos(angle: number): [number, number] {
  const a = angle & 0xffff;
  const quadrant = a >> 14;
  const x = (a & (QUARTER_STEPS - 1)) * RADIANS_PER_STEP;
  const s = sinPoly(x);
  const c = cosPoly(x);
  switch (quadrant) {
    case 0:
      return [s, c];
    case 1:
      return [c, -s];
    case 2:
      return [-s, -c];
    default:
      return [-c, s];
  }
}
