/**
 * Pace input production to keep ~2 inputs waiting in the server's queue: enough to ride out
 * jitter, not so many that they add lag. Returns a time scale (±5%) for the client's
 * fixed-step loop, from the queue depth reported in snapshots.
 */
export const TARGET_QUEUE_DEPTH = 2;

export function inputPacing(smoothedDepth: number): number {
  const scale = 1 + (TARGET_QUEUE_DEPTH - smoothedDepth) * 0.02;
  return Math.min(1.05, Math.max(0.95, scale));
}
