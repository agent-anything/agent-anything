import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import electronPath from "electron";

export function forwardElectronOutput(source, destination) {
  // Chromium writes UTF-8, including localized Windows system errors.
  source.setEncoding("utf8");
  source.pipe(destination, { end: false });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const child = spawn(electronPath, process.argv.slice(2), {
    stdio: process.platform === "win32" ? ["inherit", "pipe", "pipe"] : "inherit",
    windowsHide: false,
  });
  if (child.stdout) forwardElectronOutput(child.stdout, process.stdout);
  if (child.stderr) forwardElectronOutput(child.stderr, process.stderr);

  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"]) {
    const handler = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.once("error", error => {
    console.error("Helarc Electron launch failed:", error.message);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal) console.error(`Helarc Electron exited with signal ${signal}.`);
    // Allow pending writes to drain instead of forcing process.exit().
    process.exitCode = code ?? 1;
  });
}
