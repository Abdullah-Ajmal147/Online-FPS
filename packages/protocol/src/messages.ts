import { BinaryReader, BinaryWriter } from './binary.ts';

/** Numeric ids for binary messages sent with Colyseus sendBytes/onMessageBytes. */
export const MessageType = {
  /** Server → client once after join: confirms the server's protocol version. */
  Hello: 1,
} as const;

export interface Hello {
  protocolVersion: number;
  serverTickRate: number;
}

export function encodeHello(msg: Hello): Uint8Array {
  return new BinaryWriter(8).u16(msg.protocolVersion).u8(msg.serverTickRate).finish();
}

export function decodeHello(bytes: Uint8Array): Hello {
  const r = new BinaryReader(bytes);
  return { protocolVersion: r.u16(), serverTickRate: r.u8() };
}
