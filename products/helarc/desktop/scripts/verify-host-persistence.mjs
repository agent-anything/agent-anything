import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve, dirname, basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const directory = await mkdtemp(join(tmpdir(), "helarc-host-persistence-"));
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
let passed = false;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL("./fixtures/host-persistence.cjs", import.meta.url)), directory],
      {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    let output = "", expired = false, termination=Promise.resolve();
    child.stdout.on("data", value => {output += value;}); child.stderr.on("data", value => {output += value;});
    const timer = setTimeout(() => {
      expired = true;
      termination=process.platform==="win32"&&child.pid?new Promise(resolve=>{
        const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
      }):Promise.resolve(child.kill());
    }, 45000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", async code => {
      clearTimeout(timer);
      await termination;
      if (expired || code !== 0) reject(new Error(`Host persistence verification failed (exit=${code}, timeout=${expired})\n${output}`));
      else {process.stdout.write(output); resolve();}
    });
  });
  passed = true;
} finally {
  if (passed && process.env.HELARC_KEEP_VERIFICATION !== "1") {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-host-persistence-")) throw new Error("Unsafe fixture cleanup");
    await rm(target, {recursive: true, force: true});
  } else process.stderr.write(`Isolated evidence: ${directory}\n`);
}
