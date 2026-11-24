import {parentPort} from "node:worker_threads";
import * as codec from "../dist/main/execution-storage/ExecutionContent.js";
import {measureStorageContent} from "./fixtures/storage-work-probe.mjs";
import {acquireForegroundTestPolicy,inspectTestExecutionPolicy} from "./fixtures/test-execution-policy.mjs";

const policy=inspectTestExecutionPolicy;
let baseline,beforePolicy,afterPolicy;
if(process.env.HELARC_STORAGE_PROBE_AGE==="1") {
  beforePolicy=policy();baseline=measureStorageContent(codec);
  await new Promise(resolve=>setTimeout(resolve,20000));
  afterPolicy=policy();
}
const result={...measureStorageContent(codec),baseline,beforePolicy,afterPolicy};
if(process.env.HELARC_STORAGE_PROBE_POLICY==="1") {
  const restore=acquireForegroundTestPolicy({report(){}});
  try {
    result.highPolicy=policy();result.high=measureStorageContent(codec);
  } finally {restore();}
  result.restoredPolicy=policy();result.restored=measureStorageContent(codec);
}
if(parentPort)parentPort.postMessage(result);
else process.stdout.write(`${JSON.stringify(result)}\n`);
