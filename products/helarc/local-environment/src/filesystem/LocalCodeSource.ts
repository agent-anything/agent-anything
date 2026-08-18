import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileBaseline } from "@agent-anything/canonical-action/subject";
import type {
  CaptureCodeSourceInput,
  CodeSourceCaptureResult,
  CodeSourcePort,
  CodeSourceRehydrationResult,
  CodeSourceSnapshot,
  RehydrateCodeSourceInput,
} from "@agent-anything/helarc-code-agent/source";
import { resolveExistingTarget, resolveWritableTarget } from "./FileSystemBoundary.js";
import { FileSystemError } from "./FileSystemError.js";
import { decodeUtf8 } from "./Utf8.js";

export function createLocalCodeSourcePort(
  now: () => string = () => new Date().toISOString(),
): CodeSourcePort {
  return Object.freeze({
    async capture(input: CaptureCodeSourceInput): Promise<CodeSourceCaptureResult> {
      try {
        return Object.freeze({
          status: "captured" as const,
          snapshot: await captureSnapshot(input, now),
        });
      } catch (error) {
        return sourceFailure(error);
      }
    },
    async rehydrate(input: RehydrateCodeSourceInput): Promise<CodeSourceRehydrationResult> {
      try {
        const current = await captureSnapshot({
          workspace: input.workspace,
          rootName: input.expected.target.rootName,
          path: input.expected.target.path,
          operation: "observe",
          maxContentBytes: input.maxContentBytes,
        }, now);
        if (!sameSnapshotBasis(current, input.expected)) {
          return Object.freeze({
            status: "changed" as const,
            snapshot: current,
            owner: "helarc.code-workspace" as const,
            code: "code_source_baseline_changed",
            message: "The source target no longer matches the reviewed proposal baseline.",
          });
        }
        return Object.freeze({ status: "matched" as const, snapshot: current });
      } catch (error) {
        return sourceFailure(error);
      }
    },
  });
}

async function captureSnapshot(
  input: CaptureCodeSourceInput,
  now: () => string,
): Promise<CodeSourceSnapshot> {
  if (!Number.isSafeInteger(input.maxContentBytes) || input.maxContentBytes < 1) {
    throw new TypeError("Code source content limit must be a positive safe integer.");
  }
  if (input.operation === "create") {
    const target = await resolveWritableTarget({
      workspace: input.workspace,
      rootName: input.rootName,
      path: input.path,
      overwrite: false,
    });
    return Object.freeze({
      target: Object.freeze({
        rootName: target.resolved.rootName,
        workspaceId: target.resolved.workspaceId,
        path: target.resolved.relativePath,
      }),
      baseline: Object.freeze({ kind: "absent" as const }),
      content: null,
      contentRef: null,
      capturedAt: now(),
    });
  }

  if (input.operation === "observe") {
    try {
      return await capturePresentSnapshot(input, now);
    } catch (error) {
      if (!(error instanceof FileSystemError) || error.code !== "file_not_found") {
        throw error;
      }
      const target = await resolveWritableTarget({
        workspace: input.workspace,
        rootName: input.rootName,
        path: input.path,
        overwrite: false,
      });
      return Object.freeze({
        target: Object.freeze({
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          path: target.resolved.relativePath,
        }),
        baseline: Object.freeze({ kind: "absent" as const }),
        content: null,
        contentRef: null,
        capturedAt: now(),
      });
    }
  }

  return capturePresentSnapshot(input, now);
}

async function capturePresentSnapshot(
  input: CaptureCodeSourceInput,
  now: () => string,
): Promise<CodeSourceSnapshot> {
  const target = await resolveExistingTarget({
    workspace: input.workspace,
    rootName: input.rootName,
    path: input.path,
    expectedKind: "file",
  });
  if (target.stats.size > input.maxContentBytes) {
    throw new FileSystemError(
      "code_source_content_limit_exceeded",
      "The source file exceeds the configured proposal content limit.",
    );
  }
  const bytes = await readFile(target.canonicalTarget);
  if (bytes.byteLength > input.maxContentBytes) {
    throw new FileSystemError(
      "code_source_content_limit_exceeded",
      "The source file exceeds the configured proposal content limit.",
    );
  }
  const content = decodeUtf8(bytes);
  if (content === null) {
    throw new FileSystemError("code_source_not_utf8", "The source file is not valid UTF-8 text.");
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return Object.freeze({
    target: Object.freeze({
      rootName: target.resolved.rootName,
      workspaceId: target.resolved.workspaceId,
      path: target.resolved.relativePath,
    }),
    baseline: createBaseline(target.stats, digest),
    content,
    contentRef: Object.freeze({
      algorithm: "sha256" as const,
      digest,
      byteLength: bytes.byteLength,
    }),
    capturedAt: now(),
  });
}

function createBaseline(stats: Stats, digest: string): FileBaseline {
  return Object.freeze({
    kind: "present" as const,
    entryKind: "file" as const,
    objectIdentity: process.platform === "win32"
      ? Object.freeze({ kind: "win32" as const, volumeId: String(stats.dev), fileId: String(stats.ino) })
      : Object.freeze({ kind: "posix" as const, deviceId: String(stats.dev), inode: String(stats.ino) }),
    contentDigest: digest,
  });
}

function sameSnapshotBasis(left: CodeSourceSnapshot, right: CodeSourceSnapshot): boolean {
  return left.target.rootName === right.target.rootName &&
    left.target.workspaceId === right.target.workspaceId &&
    left.target.path === right.target.path &&
    JSON.stringify(left.baseline) === JSON.stringify(right.baseline) &&
    left.contentRef?.digest === right.contentRef?.digest &&
    left.contentRef?.byteLength === right.contentRef?.byteLength;
}

function sourceFailure(error: unknown): Exclude<
  CodeSourceCaptureResult,
  { readonly status: "captured" }
> {
  const known = error instanceof FileSystemError || error instanceof TypeError;
  return Object.freeze({
    status: known ? "invalid" as const : "failed" as const,
    owner: "helarc.code-workspace" as const,
    code: error instanceof FileSystemError ? error.code : known ? "code_source_invalid" : "code_source_capture_failed",
    message: known && error instanceof Error ? error.message : "The local source state could not be captured.",
  });
}
