import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

assert.equal(process.platform, "win32", "This verification exercises Windows sharing semantics.");
const root = await mkdtemp(join(tmpdir(), "helarc-projection-recovery-"));
const driver = fileURLToPath(new URL("./fixtures/projection-persistence.cjs", import.meta.url));
let passed = false;
async function launch(directory, scenario, stage, expectedExit = 0) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((accept, reject) => {
    const child = spawn(electron, [driver, directory, scenario, stage], {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    let output = "", expired = false;
    child.stdout.on("data", text => {output += text;}); child.stderr.on("data", text => {output += text;});
    const timer = setTimeout(() => {expired = true; child.kill();}, 150_000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", code => {
      clearTimeout(timer);
      if (expired || code !== expectedExit) reject(new Error(`${scenario}/${stage}: exit ${code}, timeout=${expired}\n${output}`));
      else accept();
    });
  });
  console.log(`${scenario}/${stage}: passed`);
}
try {
  for (const scenario of ["quiet_retry", "interrupted", "terminal_delivery", "reply_recovery"]) {
    const directory = join(root, scenario); await mkdir(directory);
    await launch(directory, scenario, "seed", ["interrupted", "reply_recovery"].includes(scenario) ? 73 : 0);
    await launch(directory, scenario, "resume");
    await launch(directory, scenario, "verify");
    console.log(await readFile(join(directory, "verification.json"), "utf8"));
  }
  passed = true;
  console.log("Real Electron + SQLite Worker projection and reply recovery passed (12 processes, actual Windows file locks).");
} finally {
  if (passed) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-projection-recovery-")) throw new Error("Unsafe cleanup target");
    await rm(target, {recursive: true, force: true});
  } else console.error(`Isolated failure evidence retained at ${root}`);
}
