import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname, basename, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const root = await mkdtemp(join(tmpdir(), "helarc-stale-task-"));
const fixture = fileURLToPath(new URL("./fixtures/stale-task-response.cjs", import.meta.url));
let passed = false;
try {
  for (const phase of ["seed", "resume", "verify"]) {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
      if(process.argv.includes("--failed-turn"))env.ACTIVITY_FAILED_TASK="1";
    await new Promise((accept, reject) => {
      const child = spawn(electron, [fixture, root, phase], {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
      let output = "", expired = false, termination = Promise.resolve();
      child.stdout.on("data", chunk => {output += chunk;}); child.stderr.on("data", chunk => {output += chunk;});
      const timer = setTimeout(() => {
        expired = true;
        if (process.platform === "win32" && child.pid) termination = new Promise(done => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
          killer.once("close", done); killer.once("error", () => {child.kill(); done();});
        });
        else child.kill();
      }, 60000);
      child.once("error", error => {clearTimeout(timer); reject(error);});
      child.once("close", async code => {
        clearTimeout(timer); await termination;
        if (expired || code !== (phase === "seed" ? 73 : 0)) reject(new Error(`${phase}: exit=${code}, timeout=${expired}\n${output}`));
        else accept();
      });
    });
    console.log(`${phase}: passed`);
  }
  console.log(await readFile(join(root, "verification.json"), "utf8"));
  passed = true;
} finally {
  if (passed) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith("helarc-stale-task-"));
    await rm(root, {recursive: true, force: true});
  } else console.error(`Isolated evidence: ${root}`);
}
