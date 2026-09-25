// Portable packages compile without the DOM or Node libs (see CLAUDE.md rule 2).
// TextEncoder/TextDecoder exist in every browser and in Node, so declare just what we use.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
