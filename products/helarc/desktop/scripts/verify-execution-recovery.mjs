import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, symlink, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve, delimiter} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

// No user's settings, credentials, execution store, or model endpoint is used.
const root = await mkdtemp(join(tmpdir(), "helarc-electron-recovery-"));
const driver = fileURLToPath(new URL("./fixtures/execution-recovery.cjs", import.meta.url));
const oldAlias = join(root, "old-toolchain"), newAlias = join(root, "new-toolchain");
await symlink(dirname(process.execPath), oldAlias, process.platform === "win32" ? "junction" : "dir");
await symlink(dirname(process.execPath), newAlias, process.platform === "win32" ? "junction" : "dir");
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
async function launch(directory, scenario, stage, expectedExit) {
  const alias = stage === "seed" ? oldAlias : newAlias;
  const environment = {...process.env, [pathKey]: `${alias}${delimiter}${process.env[pathKey] ?? ""}`,
    FNM_MULTISHELL_PATH: alias, NODE: join(alias, basename(process.execPath)),
    npm_node_execpath: join(alias, basename(process.execPath)), npm_config_npm_globalconfig: join(alias, "etc", "npmrc"),
    HELARC_RECOVERY_SECRET_TEST: "private-environment-not-for-storage-or-inspector"};
  if (stage !== "seed") environment.HELARC_NEW_HOST_ONLY = "not-for-recovered-commands";
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((accept, reject) => {
    const child = spawn(electron, [driver, directory, scenario, stage], {env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    let output = "", expired = false, termination = Promise.resolve();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => {output += text;}); child.stderr.on("data", text => {output += text;});
    const timer = setTimeout(() => {
      expired = true;
      termination = process.platform === "win32" && child.pid ? new Promise(resolve => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
        killer.once("close", resolve);
        killer.once("error", () => {child.kill(); resolve();});
      }) : Promise.resolve(child.kill());
    }, 150_000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", async code => {
      clearTimeout(timer);
      await termination;
      if (expired || code !== expectedExit) reject(new Error(`${scenario}/${stage}: exit ${code}, timeout=${expired}\n${output}`));
      else accept();
    });
  });
  console.log(`${scenario}/${stage}: passed`);
}

let passed = false;
const selected = process.argv.slice(2);
const supportedScenarios = ["accepted", "effect", "child", "opening_prepared", "continued_child", "approval", "approval_applied", "ending_feedback", "ending_exhausted", "provider_failure_saved", "provider_capacity_saved",
  "interaction_admitted", "interaction_prepared", "interaction_accepted", "interaction_call_feedback", "interaction_steering", "material_child", "material_read_prepared",
  "context_intent", "context_candidate", "context_selected", "context_frozen", "context_returned", "context_accepted",
  "semantic_generated", "semantic_assessed", "semantic_candidate", "semantic_leaf", "semantic_merge", "semantic_background", "semantic_background_adopt"];
const scenarios = selected.length ? selected : supportedScenarios;
assert(scenarios.every(value => supportedScenarios.includes(value)));
try {
  for (const scenario of scenarios) {
    const directory = join(root, scenario); await mkdir(directory);
    await launch(directory, scenario, "seed", 73);
    await launch(directory, scenario, "resume", 0);
    await launch(directory, scenario, "verify", 0);
    const report = JSON.parse(await readFile(join(directory, "resume.json"), "utf8"));
    assert.equal(report.status, ["ending_exhausted", "provider_capacity_saved"].includes(scenario) ? "failed" : "completed"); assert.equal(report.effects, 1);
    console.log(JSON.stringify(report));
  }
  passed = true;
  console.log(`Real Electron + SQLite Worker recovery passed (${scenarios.length} interruption scenarios, ${scenarios.length * 3} processes).`);
} finally {
  if (passed) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-electron-recovery-")) throw new Error("Unexpected cleanup target");
    await rm(target, {recursive: true, force: true});
  } else console.error(`Isolated failure evidence retained at ${root}`);
}
