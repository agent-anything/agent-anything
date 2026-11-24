import {createHash} from "node:crypto";

export const INSPECTION_RANGE_BYTES = 64 * 1024;
export const inspectionContentHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export interface InspectionContentRanges {
  readonly digest: string;
  readonly bytes: number;
  readonly chunkBytes: number;
  readonly chunks: readonly string[];
}
export function inspectionContentRanges(bytes: Buffer, digest: string): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += INSPECTION_RANGE_BYTES)
    chunks.push(inspectionContentHash(bytes.subarray(offset, offset + INSPECTION_RANGE_BYTES)));
  return JSON.stringify({digest, bytes: bytes.length, chunkBytes: INSPECTION_RANGE_BYTES, chunks});
}
