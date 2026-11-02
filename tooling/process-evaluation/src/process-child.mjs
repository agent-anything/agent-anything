import {spawn} from "node:child_process";
import {once} from "node:events";
import {appendFile} from "node:fs/promises";

export async function runOwnedProcess(scope, {id, executable, args, env, log, signal, onSpawn}) {
  const resource = await scope.acquire(id, "process", async () => {
    const child = spawn(executable, args, {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]});
    let closed = false, logWrites = Promise.resolve(), spawnError, logError;
    const exited = new Promise(resolve => {
      child.once("error", error => {spawnError = error;});
      child.once("close", (code, signal) => {closed = true; resolve({code, signal});});
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
      logWrites = logWrites.then(() => appendFile(log, data)).catch(error => {logError ??= error;});
    });
    let closing;
    const close = () => closing ??= (async () => {
      if (!closed) {
        if (child.connected) child.send({kind: "cancel"}, () => {});
        let timer;
        await Promise.race([exited, new Promise(resolve => {timer = setTimeout(resolve, 500);})]);
        if (timer) clearTimeout(timer);
        if (!closed) {
          if (process.platform === "win32" && child.pid) {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
            await once(killer, "close");
          } else child.kill("SIGKILL");
        }
      }
      await exited; await logWrites;
    })();
    return {id, kind: "process", child, exited, close, async result() {
      const value = await exited; await logWrites; if (spawnError) throw spawnError; if (logError) throw logError; return value;
    }};
  });
  onSpawn?.(resource.child);
  const cancel = () => {void resource.close().catch(() => {});};
  signal.addEventListener("abort", cancel, {once: true}); if (signal.aborted) cancel();
  try {return await resource.result();} finally {signal.removeEventListener("abort", cancel);}
}
