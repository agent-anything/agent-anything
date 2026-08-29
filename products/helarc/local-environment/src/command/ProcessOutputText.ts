import chardet from "chardet";
import { TextDecoder } from "node:util";

export type ProcessTextIntegrity =
  | "exact"
  | "inferred"
  | "lossy"
  | "unavailable";

export type ProcessTextEncodingSource =
  | "utf8"
  | "bom"
  | "detected"
  | "fallback"
  | "none";

export interface ProcessTextProjection {
  readonly text: string;
  readonly encoding: string | null;
  readonly encodingSource: ProcessTextEncodingSource;
  readonly integrity: ProcessTextIntegrity;
  readonly replacementCount: number;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function projectProcessOutputText(
  bytes: Uint8Array,
): ProcessTextProjection {
  if (bytes.byteLength === 0) {
    return projection("", "utf-8", "utf8", "exact", 0);
  }

  const bom = bomEncoding(bytes);
  if (bom !== null) {
    const text = decodeStrict(bytes, bom);
    if (text !== null) {
      return projection(text, bom, "bom", "exact", 0);
    }
  }

  if (looksBinary(bytes)) {
    return projection("", null, "none", "unavailable", 0);
  }

  try {
    return projection(UTF8.decode(bytes), "utf-8", "utf8", "exact", 0);
  } catch {
    // Legacy shell encodings are recovered below without upgrading them to exact.
  }

  for (const candidate of chardet.analyse(bytes)) {
    const encoding = textDecoderEncoding(candidate.name);
    if (encoding === null) continue;
    const text = decodeStrict(bytes, encoding);
    if (text !== null) {
      return projection(text, encoding, "detected", "inferred", 0);
    }
  }

  const text = Buffer.from(bytes).toString("utf8");
  return projection(
    text,
    "utf-8",
    "fallback",
    "lossy",
    countReplacementCharacters(text),
  );
}

function projection(
  text: string,
  encoding: string | null,
  encodingSource: ProcessTextEncodingSource,
  integrity: ProcessTextIntegrity,
  replacementCount: number,
): ProcessTextProjection {
  return Object.freeze({
    text,
    encoding,
    encodingSource,
    integrity,
    replacementCount,
  });
}

function decodeStrict(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return "utf-8";
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) ||
      startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    return null;
  }
  if (startsWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (startsWith(bytes, [0xfe, 0xff])) return "utf-16be";
  return null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function textDecoderEncoding(name: string): string | null {
  const normalized = name.trim().toLowerCase().replaceAll("_", "-");
  const aliases: Readonly<Record<string, string>> = {
    "utf-8": "utf-8",
    "utf-16-le": "utf-16le",
    "utf-16-be": "utf-16be",
    "shift-jis": "shift_jis",
    "euc-jp": "euc-jp",
    "euc-kr": "euc-kr",
    "iso-2022-jp": "iso-2022-jp",
    "iso-2022-kr": "iso-2022-kr",
    "iso-2022-cn": "iso-2022-cn",
    "gb18030": "gb18030",
    "big5": "big5",
    "koi8-r": "koi8-r",
  };
  if (aliases[normalized] !== undefined) return aliases[normalized];
  if (/^(?:windows|iso-8859)-\d+$/u.test(normalized)) return normalized;
  return null;
}

function countReplacementCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\ufffd") count += 1;
  }
  return count;
}
