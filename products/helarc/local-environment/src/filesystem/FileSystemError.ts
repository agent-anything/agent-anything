

export class FileSystemError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}
