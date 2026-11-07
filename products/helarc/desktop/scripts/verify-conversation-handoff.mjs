import {spawn} from "node:child_process";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const directory = await mkdtemp(join(tmpdir(), "helarc-conversation-recovery-"));
const driver = fileURLToPath(new URL("./fixtures/conversation-handoff.cjs", import.meta.url));
console.log(`Isolated evidence: ${directory}`);
for (const [phase, expected] of [["seed", 73], ["resume", 0], ["verify", 0]]) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [driver, directory, phase], {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    let output = "", expired = false, termination = Promise.resolve();
    child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
    const timer = setTimeout(() => {
      expired = true;
      termination = process.platform === "win32" ? new Promise(done => {
        const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
        kill.once("close", done); kill.once("error", () => {child.kill(); done();});
      }) : Promise.resolve(child.kill());
    }, 150000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", async code => {
      clearTimeout(timer); await termination;
      if (expired || code !== expected) reject(new Error(`${phase}: exit=${code}, expired=${expired}\n${output}`)); else resolve();
    });
  });
  console.log(`${phase}: passed`);
}
console.log(await readFile(join(directory, "resume.json"), "utf8"));
