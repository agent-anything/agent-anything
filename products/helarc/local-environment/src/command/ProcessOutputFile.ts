import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";

const TRUNCATION_MARKER = Buffer.from("\n[Helarc output truncated at the configured retention limit.]\n", "utf8");

export class ProcessOutputFile {
  private retainedBytes = 0;
  private isTruncated = false;
  private isClosed = false;

  private constructor(
    readonly absolutePath: string,
    readonly relativePath: string,
    private readonly maximumBytes: number,
    private readonly stream: WriteStream,
  ) {}

  static async create(input: {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly maximumBytes: number;
  }): Promise<ProcessOutputFile> {
    await writeFile(input.absolutePath, "", { flag: "wx" });
    return new ProcessOutputFile(
      input.absolutePath,
      input.relativePath,
      input.maximumBytes,
      createWriteStream(input.absolutePath, { flags: "a" }),
    );
  }

  append(channel: "stdout" | "stderr", chunk: Buffer): void {
    if (this.isClosed || chunk.byteLength === 0) return;
    const prefix = Buffer.from(`[${channel}] `, "utf8");
    this.writeBounded(Buffer.concat([prefix, chunk]));
  }

  get truncated(): boolean {
    return this.isTruncated;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.isTruncated && this.retainedBytes < this.maximumBytes) {
      const remaining = this.maximumBytes - this.retainedBytes;
      this.stream.write(TRUNCATION_MARKER.subarray(0, remaining));
    }
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }

  private writeBounded(value: Buffer): void {
    const remaining = this.maximumBytes - this.retainedBytes;
    if (remaining <= 0) {
      this.isTruncated = true;
      return;
    }
    const retained = value.subarray(0, remaining);
    this.retainedBytes += retained.byteLength;
    this.stream.write(retained);
    if (retained.byteLength < value.byteLength) this.isTruncated = true;
  }
}
