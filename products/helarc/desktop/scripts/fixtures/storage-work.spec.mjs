import {spawn} from "node:child_process";
import {Worker} from "node:worker_threads";
import {fileURLToPath} from "node:url";
import {cachedDataVersionTag} from "node:v8";
import {expect,it} from "vitest";
import * as codec from "../../src/main/execution-storage/ExecutionContent.ts";
import {measureStorageContent} from "./storage-work-probe.mjs";

const codeCacheTagBeforeImports=cachedDataVersionTag();
const nativeBeforeImports=new Set(process.report.getReport().sharedObjects);
if(process.env.HELARC_STORAGE_PROBE_IMPORT_HOST==="1")await import("../../src/main/HelarcMainController.ts");
const nativeImports=process.report.getReport().sharedObjects.filter(path=>!nativeBeforeImports.has(path));
if(process.env.HELARC_STORAGE_PROBE_WAIT==="1")await new Promise(resolve=>setTimeout(resolve,44000));

it("compares identical codec work in the test Host, an independent Node and a Worker",async()=>{
  const host=measureStorageContent(codec),entry=new URL("../measure-storage-work.mjs",import.meta.url);
  const independent=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(entry)],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",error="";
    const timer=setTimeout(()=>child.kill(),10000);
    child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{error+=chunk;});
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",code=>{clearTimeout(timer);if(code!==0)reject(new Error(`probe exit=${code}: ${error}`));
      else {try{resolve(JSON.parse(output));}catch(error){reject(error);}}});
  });
  const worker=new Worker(entry);
  let workerResult;
  try {
    workerResult=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("probe Worker timeout")),10000);
      worker.once("message",value=>{clearTimeout(timer);resolve(value);});
      worker.once("error",error=>{clearTimeout(timer);reject(error);});
      worker.once("exit",code=>{clearTimeout(timer);reject(new Error(`probe Worker exited without a result: ${code}`));});
    });
  } finally {await worker.terminate();}
  const work=sample=>Object.fromEntries(Object.entries(sample).filter(([key])=>!key.endsWith("Ms")&&!key.endsWith("Us")));
  for(const result of [independent,workerResult])expect(result.samples.map(work)).toEqual(host.samples.map(work));
  console.info("Fixed storage work",JSON.stringify({heavyImports:process.env.HELARC_STORAGE_PROBE_IMPORT_HOST==="1",codeCacheTagBeforeImports,nativeImports,host,independent,worker:workerResult}));
},30000);
