import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessLaunchFailure, type ProcessBackend, type ProcessBackendEvent, type ProcessBackendHandle, type ProcessLaunchRequest } from "./ProcessBackend.js";

const HEADER_BYTES = 32;
const MAX_FRAME = 1_048_576;

export async function resolveWindowsProcessHelper(directory = fileURLToPath(new URL("../../native-artifacts/win32-x64/", import.meta.url))): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64" || !isAbsolute(directory)) throw new ProcessLaunchFailure("process_backend_unsupported", "Windows x64 helper is required.", "none");
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    const path = await realpath(join(directory, "helarc-process-helper.exe"));
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (manifest.protocol !== 1 || manifest.build !== "0.1.0" || manifest.architecture !== "x64" || manifest.sha256 !== digest || path.toLowerCase().includes(".asar\\")) throw new Error("manifest mismatch");
    return path;
  } catch {
    throw new ProcessLaunchFailure("process_helper_unavailable", "Build the trusted native helper artifact before starting commands.", "none");
  }
}

export class WindowsJobProcessBackend implements ProcessBackend {
  readonly descriptor = Object.freeze({ kind: "windows_job" as const, revision: "1",
    limitations: Object.freeze(["External services and remote work are outside Job containment.", "Pipe execution uses forced Job termination, not graceful console Ctrl+C."]) });
  constructor(private readonly helperPath: string) {
    if (!isAbsolute(helperPath)) throw new TypeError("A trusted absolute helper path is required.");
  }

  launch(request: ProcessLaunchRequest, publish: (event: ProcessBackendEvent) => void): Promise<ProcessBackendHandle> {
    if (request.signal.aborted) return Promise.reject(new ProcessLaunchFailure("process_start_cancelled", "Launch cancelled.", "none"));
    return new Promise((resolve, reject) => {
      const token = randomBytes(16);
      const child = spawn(this.helperPath, [token.toString("hex")], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let sequence = 0, sentSequence = 0, requestId = 0;
      let buffer = Buffer.alloc(0), diagnostics = "";
      let launched = false, launchSent = false, ended = false, outputClosed = false, hello = false;
      let exited!: () => void;
      const exit = new Promise<void>((done) => { exited = done; });
      const terminations = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const cleanupStartup = () => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); };
      const fail = (code: string, message: string, effect: "none" | "unknown" = launchSent ? "unknown" : "none") => {
        cleanupStartup();
        if (!launched) reject(new ProcessLaunchFailure(code, message, effect));
        else publish({ kind: "failure", code, message });
        child.stdin.destroy(); child.kill();
      };
      const send = (value: unknown): void => {
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > MAX_FRAME || ended || child.stdin.destroyed) throw new Error("Process control transport is unavailable.");
        const header = Buffer.alloc(HEADER_BYTES); header.write("HPR1"); header.writeUInt32LE(++sentSequence, 4);
        header.writeUInt32LE(bytes.length, 8); header[12] = 1; token.copy(header, 16);
        child.stdin.write(Buffer.concat([header, bytes]));
      };
      const abort = () => fail("process_start_cancelled", "Process startup was cancelled.");
      const timer = setTimeout(() => fail("process_start_timeout", "Native process startup timed out."), request.startupTimeoutMs);
      request.signal.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => { if (!ended && !outputClosed) fail("process_control_lost", "Native control transport closed."); });
      child.stderr.on("data", (chunk: Buffer) => { if (diagnostics.length < 4096) diagnostics += chunk.toString("utf8").slice(0, 4096 - diagnostics.length); });
      child.once("error", (error) => fail("process_helper_start_failed", error.message, "none"));
      child.once("close", () => {
        ended = true; cleanupStartup(); exited();
        for (const pending of terminations.values()) { clearTimeout(pending.timer); pending.reject(new Error("Process termination acknowledgement lost.")); }
        terminations.clear();
        if (!launched) reject(new ProcessLaunchFailure("process_helper_closed", diagnostics || "Native helper closed before startup.", launchSent ? "unknown" : "none"));
        else if (!outputClosed) publish({ kind: "failure", code: "process_backend_lost", message: diagnostics || "Native helper closed without final output disposition." });
      });
      const metadata = (value: any) => {
        if (value.type === "hello") {
          if (hello || value.protocol !== 1 || value.build !== "0.1.0" || value.architecture !== "x86_64") throw new Error("Invalid helper handshake.");
          hello = true;
          send({ type: "launch", executable: request.executable, args: request.args, cwd: request.cwd, environment: request.environment, host_pid: process.pid });
          launchSent = true;
        } else if (value.type === "started") {
          if (!hello || launched || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.helper_pid !== child.pid || typeof value.identity !== "string") throw new Error("Invalid process start identity.");
          launched = true; cleanupStartup();
          resolve(Object.freeze({ processId: value.pid, helperProcessId: value.helper_pid, startIdentity: value.identity,
            terminate: async () => {
              const id = ++requestId;
              await new Promise<void>((done, failRequest) => {
                const timeout = setTimeout(() => { terminations.delete(id); failRequest(new Error("Process termination acknowledgement timed out.")); }, 2000);
                terminations.set(id, { resolve: done, reject: failRequest, timer: timeout });
                try { send({ type: "terminate", request_id: id }); }
                catch (error) { clearTimeout(timeout); terminations.delete(id); failRequest(error); }
              });
              return "forced" as const;
            },
            close: async () => {
              if (!ended) { child.stdin.end(); await boundedExit(exit, 2500, () => { child.kill(); }); }
            },
          }));
        } else if (value.type === "launch_failed") fail("process_launch_failed", String(value.message).slice(0, 4096), value.effect_state === "none" ? "none" : "unknown");
        else {
          if (!launched) throw new Error("Process fact precedes startup acknowledgement.");
          if (value.type === "root_exit" && Number.isInteger(value.code)) publish({ kind: "root_exit", code: value.code, signal: null });
          else if (value.type === "scope_empty") publish({ kind: "scope_empty" });
          else if (value.type === "output_closed" && typeof value.incomplete === "boolean") {
            outputClosed = true; publish({ kind: "output_closed", incomplete: value.incomplete });
          } else if (value.type === "termination_ack") {
            const pending = terminations.get(value.request_id);
            if (pending !== undefined) { clearTimeout(pending.timer); terminations.delete(value.request_id);
              if (value.applied === true) pending.resolve(); else pending.reject(new Error("TerminateJobObject failed.")); }
          } else throw new Error("Invalid native lifecycle frame.");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= HEADER_BYTES) {
            const size = buffer.readUInt32LE(8); const kind = buffer[12];
            if (buffer.toString("ascii", 0, 4) !== "HPR1" || !buffer.subarray(16, 32).equals(token) ||
              buffer.readUInt32LE(4) !== sequence + 1 || buffer[13] !== 0 || buffer[14] !== 0 || buffer[15] !== 0 ||
              ![1, 2, 3].includes(kind) || size > (kind === 1 ? MAX_FRAME : 65_536)) throw new Error("Invalid native frame header.");
            if (buffer.length < HEADER_BYTES + size) break;
            const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + size); buffer = buffer.subarray(HEADER_BYTES + size); sequence++;
            if (kind === 1) metadata(JSON.parse(payload.toString("utf8")));
            else {
              if (!launched || outputClosed) throw new Error("Output outside active capture.");
              publish({ kind: "output", stream: kind === 2 ? "stdout" : "stderr", bytes: payload });
            }
          }
          if (buffer.length > MAX_FRAME + HEADER_BYTES) throw new Error("Native frame buffer exceeded its bound.");
        } catch (error) { fail("process_protocol_invalid", error instanceof Error ? error.message : "Invalid native frame."); }
      });
      if (request.signal.aborted) abort();
    });
  }
}

async function boundedExit(exit: Promise<void>, ms: number, expire: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(() => { expire(); resolve(); }, ms); })]);
  if (timer !== undefined) clearTimeout(timer);
}
