import {mkdir,readFile,realpath,stat} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {EvaluationProcessExecution,EvaluationProcessStimulusDelivery,projectProcessTargetInput,sameProcessValue,assembleProcessCapture} from "@agent-anything/evaluation/process";
import {createProcessStore,digest,writeImmutable,readBranchFile} from "./process-storage.mjs";
import {runOwnedProcess} from "./process-child.mjs";
import {mountComparisonProvider} from "./comparison-provider.mjs";
import {ref} from "./comparison-cases.mjs";
import {assessCapturedSubsequentUse} from "./comparison-assessment.mjs";
import {captureComparisonMetrics} from "./comparison-metrics.mjs";
import {observedCaptureQuery} from "./capture-query.mjs";
const target=fileURLToPath(new URL("../../../products/helarc/desktop/scripts/evaluation/context-target.cjs",import.meta.url));
const helper=fileURLToPath(new URL("../../../products/helarc/desktop/scripts/evaluation/context-continuation.cjs",import.meta.url));
const composition=fileURLToPath(new URL("../../../products/helarc/desktop/dist/main/run/HelarcHostRunComposition.js",import.meta.url));
const optional=async file=>readFile(file,"utf8").then(JSON.parse).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
export async function runContextProcessTrial({directory,plan,live=false,interruptAfterMethod=false,signal=new AbortController().signal,timeoutMs=180000}){
  await mkdir(directory,{recursive:true});directory=await realpath(directory);
  const store=await createProcessStore(join(directory,"trial")),projection=projectProcessTargetInput(plan);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>["path","systemroot","windir","comspec","temp","tmp","pathext","userprofile","localappdata","appdata"].includes(key.toLowerCase())));
  const identity=async()=>{const info=await stat(directory);return {device:String(info.dev),inode:String(info.ino),code:digest([await readFile(target,"utf8"),await readFile(helper,"utf8"),await readFile(composition,"utf8")]),projection:digest(projection),live};};
  const stimuli=new EvaluationProcessStimulusDelivery(plan,{
    load:async()=>await optional(join(directory,"stimulus-accepted.json"))??optional(join(directory,"stimulus-receipt.json")),
    commit:async(expected,next)=>{const file=join(directory,expected?"stimulus-accepted.json":"stimulus-receipt.json");await writeImmutable(file,next);},
    verify:async fact=>sameProcessValue(fact,await optional(join(directory,"foreground-event.json"))),
    accept:async delivery=>{const file=join(directory,"released-stimulus.json"),prior=await optional(file);if(prior&&!sameProcessValue(prior,delivery))throw new Error("stimulus_identity_conflict");if(!prior)await writeImmutable(file,delivery);return ref(`${delivery.id}:recipient`);},
  });
  let launchNumber=0,mountedEndpoint;
  async function launch(mode,scope,abort){
    const endpoint=mountedEndpoint??=await mountComparisonProvider(scope,directory,{live,signal:abort});let delivery=Promise.resolve(),deliveryError;
    const result=await runOwnedProcess(scope,{id:`context-${mode}-${++launchNumber}`,executable:electron,args:[target,directory,mode,endpoint],env,log:join(directory,`${mode}-${launchNumber}.log`),signal:abort,
      onSpawn:child=>child.on("message",message=>{if(message?.kind==="condition")delivery=delivery.then(()=>stimuli.deliver([message.fact])).catch(error=>{deliveryError=error;child.send({kind:"cancel"},()=>{});});})});
    await delivery;if(deliveryError)throw deliveryError;
    if(result.code!==0&&result.code!==73)throw new Error(`context_target_exit:${result.code}; ${JSON.stringify(await optional(join(directory,"target-failure.json")))}`);
    return result;
  }
  const ports={store,environment:{
    async prepare(input,scope,abort){
      if(plan.startingState.construction.id!=="retained-material-continuation"||plan.startingState.entries.some(e=>e.disposition==="unavailable"))throw new Error("unsupported_context_start");
      const saved=await optional(join(directory,"target-input.json"));if(saved&&!sameProcessValue(saved,input))throw new Error("target_input_changed");if(!saved)await writeImmutable(join(directory,"target-input.json"),input);
      if(!await optional(join(directory,"construction.json")))await launch("prepare",scope,abort);
      const construction=await optional(join(directory,"construction.json"));if(construction?.outcome.kind!=="prepared")throw new Error("construction_unconfirmed");
      const endpoint=await optional(join(directory,"endpoint.json"));
      if(!Number.isSafeInteger(endpoint?.port)||endpoint.port<1||endpoint.port>65535)throw new Error("original_endpoint_unavailable");
      const binding={environment:await identity(),construction:digest(construction),endpoint},file=join(directory,"target-binding.json"),old=await optional(file);
      if(old&&!sameProcessValue(old,binding))throw new Error("original_binding_changed");if(!old)await writeImmutable(file,binding);
      return {startingStateRef:plan.startingState.ref,branch:plan.branch,bindings:ref(`binding:${digest(binding)}`),entries:plan.startingState.entries.map(e=>({facet:e.facet,owner:e.owner,
        disposition:e.disposition==="empty"?"confirmed_empty":"reconstructed",sourceEvidence:e.evidence,evidence:e.disposition==="empty"?[]:[ref(`construction:${digest(construction)}`)]}))};
    },
    async verify(receipt){
      const binding=await optional(join(directory,"target-binding.json"));
      if(!binding||!sameProcessValue(binding.environment,await identity())||receipt.bindings.id!==`binding:${digest(binding)}`||
        !sameProcessValue(await optional(join(directory,"target-input.json")),projection)||
        digest(await optional(join(directory,"construction.json")))!==binding.construction||
        !sameProcessValue(await optional(join(directory,"endpoint.json")),binding.endpoint))throw new Error("original_binding_unavailable");
      return receipt;
    },
  },target:{
    async invoke(_input,receipt,scope,abort){if(!await optional(join(directory,"target-result.json")))await launch(interruptAfterMethod?"interrupt-after-method":"run",scope,abort);
      const result=await optional(join(directory,"target-result.json"))??await optional(join(directory,"interruption.json"));
      return {status:result.outcome.kind==="interrupted"?"interrupted":result.outcome.kind==="used"?"completed":"failed",bindings:receipt.bindings,executionRef:ref(result.runId),evidence:[ref(`execution:${digest(result)}`)],reason:result.outcome.kind==="used"?null:result.outcome.kind};},cancel:async()=>{},
  },
  async capture(record,scope,abort){
    const startedAt=new Date().toISOString(),snapshot=await optional(join(directory,"target-result.json"))??await optional(join(directory,"interruption.json")),construction=await optional(join(directory,"construction.json"));
    const bytes=await readBranchFile(directory,"provider.jsonl",plan.captureBounds.maxBytesPerSource).catch(e=>{if(e.code==="ENOENT")return Buffer.alloc(0);throw e;});
    const provider=bytes.toString().trim().split("\n").filter(Boolean).map(JSON.parse),inspections=[];
    const query=await scope.acquire("context-capture","worker",async()=>{const service=new InspectionQueryService(plan.targetInput.inspectionRoot??join(directory,"inspection"));return {id:"context-capture",kind:"worker",service:observedCaptureQuery(service,directory),close:()=>service.close()};});
    const events=await readBranchFile(directory,"recordings.jsonl",plan.captureBounds.maxBytesPerSource).then(b=>b.toString().trim().split("\n").filter(Boolean).map(JSON.parse)).catch(e=>{if(e.code==="ENOENT")return [];throw e;});
    const recordings=[...new Map(events.map(r=>[`${r.sourceId}:${r.datasetId}`,r])).values()];
    let used=0;
    for(const recording of recordings){
      abort.throwIfAborted();const selected=await query.service.query({kind:"get_snapshot",sourceId:recording.sourceId,datasetId:recording.datasetId});
      const records=[];let after,limited=false;
      do{const page=await query.service.query({...selected.selection,kind:"list_records",limit:500,...(after?{after}:{})});
        for(const item of page.records){used+=Buffer.byteLength(JSON.stringify(item));if(used>plan.captureBounds.maxBytesPerSource||records.length>=plan.captureBounds.maxRecordsPerSource){limited=true;break;}records.push(item);}after=page.next;
      }while(after&&!limited);
      inspections.push({selection:selected.selection,records,limited,health:recording.health,phase:recording.phase});
    }
    const metrics=inspections.length?await captureComparisonMetrics(query.service,inspections,[snapshot?.runId??construction.runId],abort):null;
    const evidence={trialId:plan.trial.ref.id,snapshot,construction,provider,inspections,metrics,stimulus:await optional(join(directory,"stimulus-accepted.json"))};
    const captureRef=ref(`capture:${digest(evidence)}`);await writeImmutable(join(directory,`capture-${digest(evidence)}.json`),evidence);
    const complete=inspections.length>0&&inspections.every(i=>!i.limited&&i.phase==="closed"&&i.health?.dropped===0&&i.health.rejected===0&&i.health.unpersisted===0&&i.health.unconfirmed===0);
    return assembleProcessCapture({plan,ref:captureRef,startedAt,completedAt:new Date().toISOString(),sources:[
      {owner:"execution",status:snapshot?"complete":"unavailable",refs:snapshot?[ref(`execution:${digest(snapshot)}`)]:[],reason:snapshot?null:"owner_result_missing"},
      {owner:"provider",status:provider.length?"complete":"unavailable",refs:provider.length?[ref(`provider:${digest(provider)}`)]:[],reason:provider.length?null:"no_provider_capture"},
      {owner:"inspector",status:complete?"complete":"partial",refs:inspections.map(i=>ref(`${i.selection.sourceId}:${i.selection.datasetId}`,String(i.selection.watermark))),reason:complete?null:"recording_coverage_unconfirmed"}]});
  },
  async assess(capture){
    const evidence=await optional(join(directory,`capture-${capture.ref.id.slice("capture:".length)}.json`));
    const use=assessCapturedSubsequentUse(evidence,plan);
    return [{claim:"subsequent_use",...use,evidence:use.verdict==="insufficient_evidence"?[]:[capture.ref]},
      {claim:"private_inputs_withheld",verdict:!evidence.provider.length?"insufficient_evidence":JSON.stringify(evidence.provider).includes("private-source-facts")?"violated":"conforms",evidence:[capture.ref],explanation:"Private expectation identities checked against actual requests; absent requests cannot establish it"}];
  },
  async saveReport(report){const reference=ref(`report:${digest(report)}`);await writeImmutable(join(directory,`report-${digest(report)}.json`),report);return reference;},
  };
  return new EvaluationProcessExecution(ports).run(plan,{signal,timeoutMs,cleanupTimeoutMs:10000,captureTimeoutMs:60000});
}
