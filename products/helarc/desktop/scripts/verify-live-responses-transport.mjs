import {spawn} from "node:child_process";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const settings=process.argv[2];
if(!settings)throw new Error("Expected a non-secret settings JSON path with live:true, baseUrl, model, credentialTarget and optional encoding.");
const input=JSON.parse(await readFile(resolve(settings),"utf8"));
if(input.live!==true||Object.keys(input).some(k=>!["live","baseUrl","model","credentialTarget","encoding","credentialMode"].includes(k))||
  (input.credentialMode!==undefined&&input.credentialMode!=="ephemeral-import"))throw new Error("Explicit live opt-in and non-secret settings required");
const root=await mkdtemp(join(tmpdir(),"helarc-live-responses-")),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const fixture=fileURLToPath(new URL("./fixtures/live-responses-transport.cjs",import.meta.url));
console.log(`Live evidence and original recovery bindings: ${root}`);
await new Promise((accept,reject)=>{
  const child=spawn(electron,[fixture,root,resolve(settings)],{cwd:fileURLToPath(new URL("../",import.meta.url)),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let timedOut=false,killed=Promise.resolve(),output="";
  child.stdout.on("data",b=>{output=(output+b).slice(-12000);process.stdout.write(b);});
  child.stderr.on("data",b=>{output=(output+b).slice(-12000);});
  const timer=setTimeout(()=>{timedOut=true;killed=new Promise(done=>{
    const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
    killer.once("close",done);killer.once("error",()=>{child.kill();done();});
  });},840000);
  child.once("error",error=>{clearTimeout(timer);reject(error);});
  child.once("close",async code=>{clearTimeout(timer);await killed;code===0&&!timedOut?accept():reject(new Error(`Live verification code=${code}, timeout=${timedOut}\n${output}`));});
});
console.log("Live profile observations retained; inspect unsupported profiles and unresolved remote outcomes before claiming coverage.");
