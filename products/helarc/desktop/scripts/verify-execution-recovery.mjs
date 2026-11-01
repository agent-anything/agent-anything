import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, symlink, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve, delimiter} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
import {baselineScenarios,recoveryChecks,planRecoveryVerification} from "./execution-recovery-coverage.mjs";

const args=process.argv.slice(2),flags=args.filter(value=>value.startsWith("--")),selectors=args.filter(value=>!value.startsWith("--"));
assert(flags.every(flag=>["--list","--baseline","--current"].includes(flag)),"Unknown recovery verification flag");
assert(!(flags.includes("--baseline")&&flags.includes("--current")),"Choose baseline or current verification, not both");
assert(!(flags.includes("--baseline")||flags.includes("--current"))||!selectors.length,"Collection flags cannot be mixed with scenario selectors");
const plan=planRecoveryVerification(flags.includes("--baseline")?baselineScenarios:flags.includes("--current")?recoveryChecks.map(check=>check.id):selectors);
if(flags.includes("--list")) {console.log(JSON.stringify(plan,null,2));process.exit(0);}
for(const migration of plan.migrations)console.log(`${migration.retired}: migrated to ${[...migration.baseline,...migration.checks].join(", ")} (original checkpoint is retired)`);

// No user's settings, credentials, execution store, or model endpoint is used.
if(plan.baseline.length)await verifyBaseline(plan.baseline);
for(const check of plan.checks) {
  console.log(`Current recovery coverage ${check.id}: ${check.coverage}`);
  await new Promise((accept,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL(`./${check.script}`,import.meta.url)),...check.args],
      {windowsHide:true,stdio:["ignore","inherit","inherit"]});
    child.once("error",reject);
    child.once("close",(code,signal)=>code===0?accept():reject(new Error(`${check.id}: verifier exited ${code}, signal=${signal}`)));
  });
}
console.log(`Recovery coverage passed: ${plan.baseline.length} Run/effect baseline scenarios and ${plan.checks.length} current shared-protocol verifiers.`);

async function verifyBaseline(scenarios) {
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
assert(scenarios.every(value => baselineScenarios.includes(value)));
try {
  for (const scenario of scenarios) {
    const directory = join(root, scenario); await mkdir(directory);
    await launch(directory, scenario, "seed", 73);
    await launch(directory, scenario, "resume", 0);
    await launch(directory, scenario, "verify", 0);
    const report = JSON.parse(await readFile(join(directory, "resume.json"), "utf8"));
    assert.equal(report.status, scenario === "ending_exhausted" ? "failed" : "completed"); assert.equal(report.effects, 1);
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
}
