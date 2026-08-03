import { TextDecoder } from "node:util";

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
});

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}
