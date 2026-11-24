import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import electron from "electron";
import cases from "./fixtures/responses-case-environment.cjs";

const options = {
  directory: { type: "string" },
  ...Object.fromEntries(["authorize-live", "authorize-stored-live", "authorize-background-stored-live",
    "settle-original", "date-only", "recover"].map(name => [name, { type: "boolean" }])),
};
const continuations = {
  "settle-original": "tool-roundtrip", "date-only": "delegated-material", recover: "standalone-compaction",
};

export function planCase(args, credentialTarget) {
  const { positionals, values, tokens } = parseArgs({ args, options, allowPositionals: true, tokens: true });
  const flags = tokens.filter(t => t.kind === "option").map(t => t.name);
  assert.equal(flags.length, new Set(flags).size, "duplicate case option");
  assert.equal(positionals.length, 1, "specify exactly one Responses case");
  const [caseId] = positionals, required = cases.liveAuthority(caseId);
  const modes = flags.filter(f => Object.hasOwn(continuations, f));
  assert(modes.length <= 1 && modes.every(m => continuations[m] === caseId), "invalid continuation for this case");
  const [mode] = modes, authorities = flags.filter(f => f.startsWith("authorize-")).map(f => "--" + f);
  const settling = mode === "settle-original";
  assert.deepEqual(authorities, settling ? [] : [required], settling ? "settlement grants no live authority" : "expected " + required);
  if (mode) assert(values.directory, "continuation requires the original --directory");
  else assert(cases.isLiveTarget(credentialTarget), "set HELARC_RESPONSES_TEST_CREDENTIAL_TARGET to a dedicated test credential reference");
  if (values.directory !== undefined) assert(values.directory.trim(), "empty case directory");
  const directory = values.directory ? resolve(values.directory) : join(tmpdir(), "helarc-responses-" + caseId + "-" + randomUUID());
  const extra = caseId === "standalone-compaction" ? [mode === "recover" ? "recover" : "seed"] : mode === "date-only" ? ["--date-only"] : [];
  return { caseId, directory, setup: mode ? "reopen" : "prepare-live", args: [directory, settling ? "--settle-original" : required, ...extra] };
}

// The body runs only after its setup Worker has closed. An interrupted body is never restarted here.
export function runPreparedCase(plan, setup, body) {
  const status = setup(plan.setup, plan.caseId, plan.directory);
  return status === 0 ? body(plan) : status;
}

if (import.meta.main) {
  try {
    const plan = planCase(process.argv.slice(2), process.env.HELARC_RESPONSES_TEST_CREDENTIAL_TARGET);
    const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const boot = (script, args) => {
      const result = spawnSync(electron, [join(fixtures, script), ...args], { env, stdio: "inherit", windowsHide: true });
      if (result.error) throw result.error;
      return result.status ?? 1;
    };
    console.log("Responses test directory:", plan.directory);
    process.exitCode = runPreparedCase(plan,
      (...args) => boot("responses-case-setup.cjs", args),
      ({ caseId, args }) => boot("responses-" + caseId + "-live.cjs", args));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
