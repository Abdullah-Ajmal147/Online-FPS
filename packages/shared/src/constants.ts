/** Netcode contract — see docs/NETCODE.md. Change only with an ADR. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;
export const TICKS_PER_SNAPSHOT = TICK_RATE / SNAPSHOT_RATE;
export const INPUT_REDUNDANCY = 3;
/** Lag-compensation cap (ADR 0006: RTT + interpolation + input buffer at 150 ms ping ≈ 283 ms). */
export const MAX_REWIND_MS = 300;
export const MAX_PLAYERS_PER_MATCH = 12;
