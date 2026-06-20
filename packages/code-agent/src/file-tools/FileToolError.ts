import type { Metadata } from "@agent-anything/shared";

export class FileToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly metadata: Metadata = {},
  ) {
    super(message);
    this.name = "FileToolError";
  }
}
