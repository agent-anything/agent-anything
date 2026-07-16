import type { Metadata } from "@agent-anything/shared";

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
