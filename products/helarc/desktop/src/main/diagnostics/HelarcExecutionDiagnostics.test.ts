import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {captureExecutionError, restoreExecutionError} from "./ExecutionErrorDetails.js";
import {HelarcExecutionDiagnostics, reportExecutionFailure} from "./HelarcExecutionDiagnostics.js";

const directories: string[] = [];
beforeEach(() => {vi.spyOn(console, "error").mockImplementation(() => {});});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true});
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "helarc-diagnostics-"));
  directories.push(path);
  return path;
}

describe("execution exception diagnostics", () => {
  it("preserves names, stacks, commit identifiers and nested causes across a JSON transport", () => {
    const cause = Object.assign(new TypeError("Run lifecycle mismatch"), {code: "invalid_state"});
    const failure = Object.assign(new Error("Commit was not confirmed", {cause}), {name: "RunCommitError", commitId: "run-1:commit:3"});
    const restored = restoreExecutionError(JSON.parse(JSON.stringify(captureExecutionError(failure))));
    expect(restored).toMatchObject({name: "RunCommitError", message: failure.message, stack: failure.stack,
      commitId: failure.commitId, cause: {name: "TypeError", message: cause.message, stack: cause.stack, code: cause.code}});
  });

  it("bounds and sanitizes exception details without serializing arbitrary attached data", () => {
    const failure = Object.assign(new Error("Authorization: Bearer secret-bearer api_key=secret-key https://user:secret-password@localhost"), {
      request: {body: "private-request"}, credential: "private-credential",
    });
    const encoded = JSON.stringify(captureExecutionError(failure));
    for (const value of ["secret-bearer", "secret-key", "secret-password", "private-request", "private-credential"]) expect(encoded).not.toContain(value);
    expect(encoded).toContain("[redacted]");
    Object.defineProperty(failure, "cause", {value: failure});
    expect(captureExecutionError(failure).cause?.name).toBe("TruncatedCause");
    expect(captureExecutionError(new Error("x".repeat(10_000))).message.length).toBeLessThan(2100);
    expect(captureExecutionError({get message() {throw new Error("inaccessible");}}).message).toBe("No error message available.");
  });

  it("retains a bounded local history independent of execution storage", async () => {
    const path = join(await directory(), "execution-diagnostics.json");
    const diagnostics = new HelarcExecutionDiagnostics(path);
    for (let index = 0; index < 35; index++) {
      diagnostics.record("storage_worker_rejected", {runId: "run-1", revision: index}, new TypeError("Run lifecycle mismatch"));
      await diagnostics.flush();
    }
    const text = await readFile(path, "utf8");
    const records = JSON.parse(text);
    expect(records).toHaveLength(32);
    expect(records[0].context.revision).toBe(3);
    expect(records.at(-1)).toMatchObject({stage: "storage_worker_rejected", processId: process.pid,
      context: {runId: "run-1", revision: 34}, error: {name: "TypeError", message: "Run lifecycle mismatch"}});
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 * 1024);
  });

  it("never replaces execution failure when its sink or file write fails", async () => {
    const blocker = join(await directory(), "not-a-directory");
    await writeFile(blocker, "occupied");
    const diagnostics = new HelarcExecutionDiagnostics(join(blocker, "execution-diagnostics.json"));
    expect(() => diagnostics.record("active_run_rejected", {runId: "run-1"}, new Error("original"))).not.toThrow();
    await expect(diagnostics.flush()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("Helarc execution diagnostic could not be saved.");
    expect(() => reportExecutionFailure({record() {throw new Error("unavailable");}}, "failure", {}, new Error("original"))).not.toThrow();
  });
});
