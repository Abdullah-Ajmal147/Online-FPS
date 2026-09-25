/**
 * Bump on EVERY change to any message layout (CLAUDE.md rule 4).
 * Server rejects clients whose version differs with RELOAD_REQUIRED.
 */
export const PROTOCOL_VERSION = 1;

/** Close/error code sent when a client's PROTOCOL_VERSION does not match the server's. */
export const RELOAD_REQUIRED = 'RELOAD_REQUIRED';
