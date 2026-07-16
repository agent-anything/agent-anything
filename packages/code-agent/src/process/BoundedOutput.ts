import { Buffer } from "node:buffer";

export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private didTruncate = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    const remaining = this.maxBytes - this.retainedBytes;
    if (remaining <= 0) {
      this.didTruncate = true;
      return;
    }

    if (chunk.byteLength <= remaining) {
      this.chunks.push(chunk);
      this.retainedBytes += chunk.byteLength;
      return;
    }

    this.chunks.push(chunk.subarray(0, remaining));
    this.retainedBytes += remaining;
    this.didTruncate = true;
  }

  get truncated(): boolean {
    return this.didTruncate;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
  }
}
