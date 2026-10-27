export interface ProcessOutputPosition { readonly stdout: number; readonly stderr: number; }

export function encodeProcessOutputCursor(executionId: string, position: ProcessOutputPosition): string {
  return Buffer.from(JSON.stringify({version: 1, executionId, generation: 1, ...position})).toString("base64url");
}

export function decodeProcessOutputCursor(cursor: string, executionId: string, available: ProcessOutputPosition): ProcessOutputPosition {
  try {
    if (typeof cursor !== "string" || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed.version !== 1 || parsed.executionId !== executionId || parsed.generation !== 1) throw new Error();
    for (const stream of ["stdout", "stderr"] as const) {
      if (!Number.isSafeInteger(parsed[stream]) || parsed[stream] < 0 || parsed[stream] > available[stream]) throw new Error();
    }
    return {stdout: parsed.stdout, stderr: parsed.stderr};
  } catch { throw new Error("process_output_cursor_invalid"); }
}
