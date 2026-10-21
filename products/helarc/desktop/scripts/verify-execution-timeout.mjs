import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const vitest = fileURLToPath(new URL("../../../../node_modules/vitest/vitest.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "helarc-timeout-verification-"));
async function launch(directory, stalled, nextOnly = false) {
  await mkdir(directory, {recursive: true});
  const report = join(directory, nextOnly ? "following-report.json" : "report.json");
  const args = [vitest, "run", "--config", "scripts/execution-timeout.vitest.config.ts", "--reporter=json", `--outputFile=${report}`];
  if (nextOnly) args.push("-t", "starts the next test");
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {cwd: desktop, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: {...process.env, HELARC_TIMEOUT_FIXTURE_DIRECTORY: directory, HELARC_TIMEOUT_FIXTURE_STALLED: stalled ? "1" : "0",
        HELARC_TIMEOUT_FIXTURE_NEXT_ONLY: nextOnly ? "1" : "0"}});
    let output = "", expired = false;
    const watchdog = setTimeout(() => {
      expired = true;
      if (process.platform === "win32") {
        const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
        kill.once("error", reject);
      } else process.kill(-child.pid, "SIGKILL");
    }, 120_000);
    child.stdout.on("data", value => {output += value;}); child.stderr.on("data", value => {output += value;});
    child.once("error", error => {clearTimeout(watchdog); reject(error);});
    child.once("close", code => {
      clearTimeout(watchdog);
      if (expired) reject(new Error(`Timeout verification process did not exit:\n${output}`));
      else accept({code, output, report});
    });
  });
}
let passed = false;
try {
  const graceful = join(root, "graceful");
  const first = await launch(graceful, false);
  assert.equal(first.code, 1, first.output);
  const report = JSON.parse(await readFile(first.report, "utf8"));
  assert.equal(report.numFailedTests, 1, first.output); assert.equal(report.numPassedTests, 1, first.output);
  assert(JSON.stringify(report).includes("Test timed out"));
  assert.equal(JSON.parse(await readFile(join(graceful, "cancelled.json"), "utf8")).status, "cancelled");
  assert.equal(JSON.parse(await readFile(join(graceful, "following.json"), "utf8")).quiescent, true);
  console.log("Real Vitest timeout: Run cancelled, SQLite Worker exited, following test passed.");
  const stalled = join(root, "stalled");
  const forced = await launch(stalled, true);
  assert.equal(forced.code, 1, forced.output);
  assert(forced.output.includes("terminating its isolated test process"), forced.output);
  assert(!forced.output.includes("process.exit unexpectedly called"), forced.output);
  const stopped = JSON.parse(await readFile(join(stalled, "started.json"), "utf8"));
  assert.throws(() => process.kill(stopped.processId, 0), {code: "ESRCH"});
  await assert.rejects(readFile(join(stalled, "following.json")), {code: "ENOENT"});
  const after = await launch(stalled, true, true);
  assert.equal(after.code, 0, after.output);
  assert.equal(JSON.parse(await readFile(join(stalled, "following.json"), "utf8")).quiescent, true);
  console.log("Noncooperative body: owned fork terminated; next process reopened the database with no residual work.");
  passed = true;
} finally {
  if (passed) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-timeout-verification-")) throw new Error("Unexpected cleanup path");
    await rm(target, {recursive: true, force: true});
  } else console.error(`Timeout verification evidence retained at ${root}`);
}
