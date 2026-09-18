import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProcessOutputPaths } from "./ProcessOutputStore.js";

export interface RetainedProcessOutputLocator {
  readonly executionId: string;
  readonly generation: number;
  readonly workspace: string;
  readonly files: Readonly<
    Record<
      "stdout" | "stderr" | "manifest",
      {
        readonly path: string;
        readonly dev: string;
        readonly ino: string;
        readonly birthtimeMs: number;
        readonly bytes: number;
        readonly mtimeMs: number;
      }
    >
  >;
}
export class RetainedProcessOutputError extends Error {
  constructor(
    readonly reason:
      | "missing"
      | "incomplete_manifest"
      | "source_changed"
      | "read_failed",
  ) {
    super(reason);
  }
}

export async function registerRetainedProcessOutput(
  executionId: string,
  workspace: string,
  paths: ProcessOutputPaths,
): Promise<RetainedProcessOutputLocator> {
  const canonicalRoot = await realpath(workspace);
  const capture = async (path: string) => {
    const canonicalPath = await realpath(path);
    await checkPath(canonicalRoot, canonicalPath);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new RetainedProcessOutputError("source_changed");
    return {
      path: canonicalPath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeMs: stat.birthtimeMs,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  };
  return {
    executionId,
    generation: 1,
    workspace: canonicalRoot,
    files: {
      stdout: await capture(paths.stdoutText),
      stderr: await capture(paths.stderrText),
      manifest: await capture(paths.manifest),
    },
  };
}

export async function readRetainedProcessOutput(
  locator: RetainedProcessOutputLocator,
  cursor?: string,
) {
  const handles: FileHandle[] = [];
  try {
    for (const key of ["stdout", "stderr", "manifest"] as const) {
      const file = locator.files[key];
      await checkPath(locator.workspace, file.path);
      const handle = await open(file.path, "r");
      handles.push(handle);
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        String(stat.dev) !== file.dev ||
        String(stat.ino) !== file.ino ||
        stat.birthtimeMs !== file.birthtimeMs ||
        stat.size !== file.bytes ||
        stat.mtimeMs !== file.mtimeMs
      )
        throw new RetainedProcessOutputError("source_changed");
    }
    if (
      locator.files.manifest.bytes > 64 * 1024 ||
      locator.files.manifest.bytes === 0
    )
      throw new RetainedProcessOutputError("incomplete_manifest");
    const manifest = JSON.parse(await handles[2]!.readFile("utf8"));
    if (
      manifest.executionId !== locator.executionId ||
      manifest.generation !== locator.generation ||
      manifest.persistenceFailure !== null
    )
      throw new RetainedProcessOutputError("incomplete_manifest");
    const positions = cursor
      ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
      : {
          executionId: locator.executionId,
          generation: locator.generation,
          stdout: 0,
          stderr: 0,
        };
    if (
      cursor &&
      (cursor.length > 4096 ||
        positions.executionId !== locator.executionId ||
        positions.generation !== locator.generation)
    )
      throw new RetainedProcessOutputError("source_changed");
    const stream = async (key: "stdout" | "stderr", handle: FileHandle) => {
      const info = manifest.streams?.[key];
      const from = positions[key];
      if (
        !info ||
        !Number.isSafeInteger(info.textBytes) ||
        info.textBytes !== locator.files[key].bytes ||
        !Number.isSafeInteger(from) ||
        from < 0 ||
        from > info.textBytes
      )
        throw new RetainedProcessOutputError("incomplete_manifest");
      const buffer = Buffer.alloc(Math.min(16 * 1024, info.textBytes - from));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      if (bytesRead !== buffer.length)
        throw new RetainedProcessOutputError("source_changed");
      let end = bytesRead;
      let text: string;
      for (;;) {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, end),
          );
          break;
        } catch {
          if (bytesRead - end >= 3 || from + bytesRead === info.textBytes)
            throw new RetainedProcessOutputError("read_failed");
          end--;
        }
      }
      return {
        text,
        next: from + end,
        hasMore: from + end < info.textBytes,
        encoding: info.projection?.encoding ?? null,
        integrity: info.projection?.integrity ?? "unavailable",
        omittedBytes: info.omittedBytes,
        replacementCount: info.projection?.replacementCount ?? 0,
      } as const;
    };
    const stdout = await stream("stdout", handles[0]!);
    const stderr = await stream("stderr", handles[1]!);
    return {
      stdout,
      stderr,
      hasMore: stdout.hasMore || stderr.hasMore,
      nextCursor: Buffer.from(
        JSON.stringify({
          executionId: locator.executionId,
          generation: locator.generation,
          stdout: stdout.next,
          stderr: stderr.next,
        }),
      ).toString("base64url"),
    };
  } catch (error) {
    if (error instanceof RetainedProcessOutputError) throw error;
    throw new RetainedProcessOutputError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing"
        : "read_failed",
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

async function checkPath(workspace: string, path: string): Promise<void> {
  const rel = relative(workspace, resolve(path));
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../") ||
    isAbsolute(rel)
  )
    throw new RetainedProcessOutputError("source_changed");
  const canonical = await realpath(path);
  const same =
    process.platform === "win32"
      ? canonical.toLowerCase() === resolve(path).toLowerCase()
      : canonical === resolve(path);
  if (!same || (await lstat(path)).isSymbolicLink())
    throw new RetainedProcessOutputError("source_changed");
}
