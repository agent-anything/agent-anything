import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

assert.equal(process.platform, "win32");
const root = await mkdtemp(join(tmpdir(), "helarc-command-delivery-"));
const driver = fileURLToPath(new URL("./fixtures/command-delivery.cjs", import.meta.url));
async function launch(directory, scenario, stage) {
  const env = {...process.env, HELARC_VERIFICATION_NODE: process.execPath}; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((accept, reject) => {
    const child = spawn(electron, [driver, directory, scenario, stage], {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    let output = "", expired = false, termination = Promise.resolve();
    child.stdout.on("data", text => {output += text;}); child.stderr.on("data", text => {output += text;});
    const timer = setTimeout(() => {
      expired = true;
      termination = new Promise(resolve => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
        killer.once("close", resolve); killer.once("error", () => {child.kill(); resolve();});
      });
    }, 60000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", async code => {
      clearTimeout(timer); await termination;
      if (expired || code !== (stage === "seed" ? 73 : 0)) reject(new Error(`${scenario}/${stage}: exit=${code}, timeout=${expired}\n${output}`));
      else accept();
    });
  });
  console.log(`${scenario}/${stage}: passed`);
}
let passed = false;
try {
  for (const scenario of ["completed_large", "receipt_before", "receipt_after", "receipt_ack_lost", "initial_missing", "retention_failed", "search_prepared", "search_result"]) {
    const directory = join(root, scenario); await mkdir(directory);
    for (const stage of ["seed", "resume", "verify"]) await launch(directory, scenario, stage);
    console.log(await readFile(join(directory, "verification.json"), "utf8"));
  }
  passed = true;
  console.log("Command delivery verified with actual Electron, SQLite Worker and Windows Job processes (8 scenarios, 24 Electron processes).");
} finally {
  if (passed) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-command-delivery-")) throw new Error("Unsafe cleanup target");
    await rm(target, {recursive: true, force: true});
  } else console.error(`Failure evidence retained at ${root}`);
}
