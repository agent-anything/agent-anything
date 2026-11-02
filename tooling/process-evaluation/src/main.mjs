import {mkdtemp, mkdir, readFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {processPlan, runDesktopProcessTrial} from "./process-runner.mjs";

const flags = process.argv.slice(2);
const argument = name => {const index = flags.indexOf(name); return index < 0 ? null : flags[index + 1];};
const resumed = argument("--resume");
const directory = resumed ? resolve(resumed) : await mkdtemp(join(tmpdir(), "helarc-process-evaluation-"));
let plan;
if (resumed) {
  const files = (await readdir(join(directory, "trial"))).filter(name => /^revision-\d+\.json$/.test(name)).sort((a,b) => Number(b.slice(9,-5))-Number(a.slice(9,-5)));
  plan = JSON.parse(await readFile(join(directory, "trial", files[0]), "utf8")).record.plan;
} else plan = processPlan(`trial-${randomUUID()}`, {child: flags.includes("--child")});
await mkdir(directory, {recursive: true});
console.log(`Isolated process Trial: ${directory}`);
const cancellation = new AbortController();
process.once("SIGINT", () => cancellation.abort());
const outcome = await runDesktopProcessTrial({directory, plan, interruptAfterEffect: flags.includes("--interrupt-after-effect"), signal: cancellation.signal});
console.log(JSON.stringify(outcome, null, 2));
if (outcome.report.execution === "failed" || outcome.report.cleanup.status !== "cleaned" || outcome.reportFailure) process.exitCode = 1;
