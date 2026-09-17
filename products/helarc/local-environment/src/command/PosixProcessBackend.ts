import { spawn } from "node:child_process";
import { ProcessLaunchFailure, type ProcessBackend, type ProcessBackendEvent, type ProcessBackendHandle, type ProcessLaunchRequest } from "./ProcessBackend.js";

export class PosixProcessBackend implements ProcessBackend {
  readonly descriptor = Object.freeze({ kind: "posix_process_group" as const, revision: "1", limitations: Object.freeze([
    "Escaped sessions and external services are outside process-group containment.",
    "Process groups do not guarantee cleanup after Host crash.",
  ]) });
  launch(request: ProcessLaunchRequest, publish: (event: ProcessBackendEvent) => void): Promise<ProcessBackendHandle> {
    if (process.platform === "win32") return Promise.reject(new ProcessLaunchFailure("process_backend_unsupported", "POSIX backend is unavailable on Windows.", "none"));
    return new Promise((resolve, reject) => {
      if (request.signal.aborted) { reject(new ProcessLaunchFailure("process_start_cancelled", "Launch cancelled.", "none")); return; }
      const child = spawn(request.executable, [...request.args], { cwd: request.cwd, env: { ...request.environment },
        detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let empty = false, rootExited = false, streamsClosed = false, drainTimer: ReturnType<typeof setTimeout> | null = null;
      let forceTimer: ReturnType<typeof setTimeout> | null = null;
      let launched = false;
      const signal = (force: boolean) => {
        if (empty || child.pid === undefined) return;
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      const abort = () => { try { signal(true); } catch {} };
      request.signal.addEventListener("abort", abort, { once: true });
      const startupTimer = setTimeout(() => {
        abort(); reject(new ProcessLaunchFailure("process_start_timeout", "Process startup timed out.", child.pid === undefined ? "none" : "unknown"));
      }, request.startupTimeoutMs);
      const poll = setInterval(() => {
        if (!rootExited || empty || child.pid === undefined) return;
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") { publish({ kind: "failure", code: "process_scope_unknown", message: "Process group cannot be inspected." }); return; }
          empty = true; clearInterval(poll); publish({ kind: "scope_empty" });
          if (!streamsClosed) drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy();
            if (!streamsClosed) { streamsClosed = true; publish({ kind: "output_closed", incomplete: true }); } }, 2000);
        }
      }, 20);
      child.stdout.on("data", (bytes: Buffer) => publish({ kind: "output", stream: "stdout", bytes }));
      child.stderr.on("data", (bytes: Buffer) => publish({ kind: "output", stream: "stderr", bytes }));
      child.once("spawn", () => {
        clearTimeout(startupTimer); launched = true;
        request.signal.removeEventListener("abort", abort);
        resolve(Object.freeze({ processId: child.pid!, helperProcessId: null, startIdentity: `${child.pid}:${process.hrtime.bigint()}`,
          terminate: async () => { signal(false); forceTimer ??= setTimeout(() => { try { signal(true); } catch {} }, 500); return "graceful" as const; },
          close: async () => { clearInterval(poll); if (forceTimer !== null) clearTimeout(forceTimer); if (drainTimer !== null) clearTimeout(drainTimer); },
        }));
      });
      child.once("error", (error) => { clearTimeout(startupTimer); clearInterval(poll); request.signal.removeEventListener("abort", abort);
        if (launched) publish({kind:"failure",code:"process_backend_failed",message:error.message});
        else reject(new ProcessLaunchFailure("process_launch_failed", error.message, child.pid === undefined ? "none" : "unknown")); });
      child.once("exit", (code, signal) => { rootExited = true; publish({ kind: "root_exit", code, signal }); });
      child.once("close", () => { if (!streamsClosed) { streamsClosed = true; publish({ kind: "output_closed", incomplete: false }); } });
    });
  }
}
