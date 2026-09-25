/** Three.js cameras take a vertical FOV; players think in horizontal FOV. */
export function verticalFovDegrees(horizontalDeg: number, aspect: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}
