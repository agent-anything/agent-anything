import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import electron from "electron";

const environment = {...process.env};
delete environment.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/file-tools.cjs", import.meta.url))],
    {env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  let output = "", expired = false;
  child.stdout.on("data", value => {output += value;});
  child.stderr.on("data", value => {output += value;});
  const timeout = setTimeout(() => {expired = true; child.kill();}, 30000);
  child.once("error", error => {clearTimeout(timeout); reject(error);});
  child.once("close", code => {
    clearTimeout(timeout);
    if (expired || code !== 0) reject(new Error(`File tools verification failed (exit=${code}, timeout=${expired})\n${output}`));
    else {process.stdout.write(output); resolve();}
  });
});
