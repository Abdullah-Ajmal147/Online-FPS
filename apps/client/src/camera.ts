/** Three.js cameras take a vertical FOV; players think in horizontal FOV. */
export function verticalFovDegrees(horizontalDeg: number, aspect: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}

/**
 * The horizontal FOV at a magnification: things look `magnification` times bigger, so the
 * tangent of the half-angle shrinks by that factor (2× halves tan, not the angle).
 */
export function zoomedFovDegrees(horizontalDeg: number, magnification: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / magnification) * 180) / Math.PI;
}
