import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forwardElectronOutput } from "./run-electron.mjs";

describe("Electron launch diagnostics", () => {
  it("decodes split UTF-8 characters and keeps output channels and destinations open", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = collect();
    const err = collect();
    forwardElectronOutput(stdout, out.stream);
    forwardElectronOutput(stderr, err.stream);
    const message = "Unable to move the cache: \u62d2\u7edd\u8bbf\u95ee\u3002 (0x5)\n";
    for (const byte of Buffer.from(message)) stderr.write(Buffer.from([byte]));
    stdout.end("normal output\n");
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
    expect(out.text()).toBe("normal output\n");
    expect(err.text()).toBe(message);
    expect(out.stream.writableEnded).toBe(false);
    expect(err.stream.writableEnded).toBe(false);
  });

  it("drains buffered logs under backpressure without losing the final text", async () => {
    const source = new PassThrough();
    let text = "";
    const destination = new Writable({ highWaterMark: 1, decodeStrings: false,
      write(chunk, _encoding, done) { setImmediate(() => { text += chunk; done(); }); },
    });
    forwardElectronOutput(source, destination);
    const expected = "\u62d2\u7edd\u8bbf\u95ee\u3002\n".repeat(200);
    for (const character of expected) source.write(Buffer.from(character));
    source.end("last log\n");
    await finished(source);
    await new Promise(resolve => destination.write("", resolve));
    expect(text).toBe(`${expected}last log\n`);
  });

  it("forwards real Electron output and preserves its nonzero exit code without starting Helarc", async () => {
    const launcher = fileURLToPath(new URL("./run-electron.mjs", import.meta.url));
    const code = `const message = 'Native error: \\u62d2\\u7edd\\u8bbf\\u95ee\\u3002 (0x5)\\n';
      for (const byte of Buffer.from(message)) require('node:fs').writeSync(2, Buffer.from([byte]));
      process.stdout.write('stdout stays separate\\n'); process.exitCode = 7;`;
    const child = spawn(process.execPath, [launcher, "-e", code], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    const [exitCode] = await once(child, "close");
    expect(exitCode).toBe(7);
    expect(stdout).toBe("stdout stays separate\n");
    expect(stderr).toBe("Native error: \u62d2\u7edd\u8bbf\u95ee\u3002 (0x5)\n");
  });
});

function collect() {
  let output = "";
  const stream = new Writable({ decodeStrings: false,
    write(chunk, _encoding, done) { output += chunk; done(); },
  });
  return { stream, text: () => output };
}
