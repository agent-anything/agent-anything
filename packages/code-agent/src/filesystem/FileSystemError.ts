import type { Metadata } from "@agent-anything/foundation";

export class FileSystemError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly metadata: Metadata = {},
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}
