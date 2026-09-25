/**
 * Wire quantization (docs/NETCODE.md, ADR 0003).
 * Other players' positions: 1/64 m in int32. The receiving player's own state: exact float32.
 */
export const POSITION_UNITS_PER_METRE = 64;

export function quantizePosition(metres: number): number {
  return Math.round(metres * POSITION_UNITS_PER_METRE);
}

export function dequantizePosition(units: number): number {
  return units / POSITION_UNITS_PER_METRE;
}
