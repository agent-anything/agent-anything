import {mkdir, readFile, writeFile, appendFile, stat, realpath} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import electron from "electron";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {createEvaluationProcessPlan, processStartingStateFacets, EvaluationProcessExecution, projectProcessTargetInput,
  reviewProcessStartingState, sameProcessValue, assembleProcessCapture} from "@agent-anything/evaluation/process";
import {createProcessStore, digest, writeImmutable, readBranchFile} from "./process-storage.mjs";
import {runOwnedProcess} from "./process-child.mjs";
import {mountComparisonProvider} from "./comparison-provider.mjs";
import {mountProcessProvider} from "./process-provider.mjs";
import {assessCapturedSubsequentUse} from "./comparison-assessment.mjs";
import {captureComparisonMetrics} from "./comparison-metrics.mjs";
import {observedCaptureQuery} from "./capture-query.mjs";

const ref = (id, revision = "1") => ({id, revision});
const targetFile = fileURLToPath(new URL("../../../products/helarc/desktop/scripts/evaluation/process-target.cjs", import.meta.url));
const formalComposition = fileURLToPath(new URL("../../../products/helarc/desktop/dist/main/run/HelarcHostRunComposition.js", import.meta.url));
const loadJson = async file => JSON.parse(await readFile(file, "utf8"));
async function optionalJson(file) {return loadJson(file).catch(error => {if (error.code === "ENOENT") return null; throw error;});}

export function processPlan(id, {child = false, wait = false, question = false, initialEffect = false, foreignReadPath = null, inspectionSettings = null} = {}) {
  return createEvaluationProcessPlan({trial: {ref: ref(id), campaignRef: ref("process-foundation"), targetSnapshotRef: ref("helarc-default-composition"),
    caseRef: ref(child ? "delegated-effect" : "one-effect"), repetitionOrdinal: 1, seed: "fixed", pairingKey: "common-task-start",
    environmentProtocolRef: ref("isolated-desktop-process"), createdAt: new Date().toISOString(), metadata: {}}, mode: "actual_process",
    startingState: {ref: ref(initialEffect ? "retained-local-effect-start" : "empty-task-start"),
      construction: ref(initialEffect ? "isolated-local-effect-state" : "isolated-empty-workspace"), boundary: "task_start",
      entries: processStartingStateFacets.map(facet => ({facet, owner: "formal-target",
        disposition: initialEffect && facet === "completed_effects" ? "reconstructible" : "empty",
        evidence: initialEffect && facet === "completed_effects" ? [ref("original-local-effect-state")] : []}))},
    branch: {trialId: id, branchId: id, workspaceId: `${id}:workspace`, storageId: `${id}:storage`, authorityId: `${id}:authority`,
      activityNamespace: `${id}:activities`, commonHistory: ref("common-task-start")},
    targetInput: {prompt: (initialEffect ? "The retained effect.txt already contains y from completed earlier work. " : "") + (child ? "Delegate to one child: append x once to effect.txt using the shell and return its result." : "Append x once to effect.txt using the shell, then finish."),
      scenario: wait ? "wait" : question ? "question" : "complete", foreignReadPath, ...(inspectionSettings?{inspectionSettings}:{})}, variants: [], expectationRefs: [ref("private-effect-expectation")],
    claimRefs: ["effect_once", "private_inputs_withheld", "inspector_coverage"].map(id => ref(id)), captureSources: ["execution", "provider", "environment", "inspector"],
    captureBounds: {maxBytesPerSource: 16777216, maxRecordsPerSource: 10000},
    futureStimuli: [{id: "held-out-question", condition: {owner: "evaluation-task", fact: "followup_requested", subject: id}, input: "PRIVATE_FUTURE_QUESTION_9b4f"}],
    capturePolicyRef: ref("process-evidence-local-explicit"), evidenceLimitations: ["controlled_target_results_do_not_establish_model_quality"]});
}

export async function runDesktopProcessTrial({directory, plan, interruptAfterEffect = false, signal = new AbortController().signal,
  timeoutMs = 150000, corruptReceipt = false, onRequest}) {
  await mkdir(directory, {recursive: true});
  directory = await realpath(directory);
  const store = await createProcessStore(join(directory, "trial"));
  const projection = projectProcessTargetInput(plan);
  let endpoint, launchNumber = 0;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["path", "systemroot", "windir", "comspec", "temp", "tmp", "pathext", "userprofile", "localappdata", "appdata"].includes(key.toLowerCase())));
  const rootIdentity = async () => {
    const value = await stat(directory);
    return {device: String(value.dev), inode: String(value.ino), code: digest([await readFile(targetFile, "utf8"), await readFile(formalComposition, "utf8")])};
  };
  const mount = async (scope, abort) => {
    if(plan.targetInput.comparison==="C04") {endpoint=await mountComparisonProvider(scope,directory,{live:plan.targetInput.live,signal:abort});return;}
    endpoint = await mountProcessProvider(scope,directory,{signal:abort,maximumRequestBytes:plan.captureBounds.maxBytesPerSource,
      respond:async({body,signal:requestSignal})=>{
          onRequest?.(body);
          if (plan.targetInput.scenario === "wait") await delay(2147483647,undefined,{signal:requestSignal});
          const tools = body.tools.map(value => value.function.name);
          const pick = base => tools.find(name => name === base || name.startsWith(`${base}_`));
          const settled = body.messages.some(message => message.role === "tool");
          const delegate = body.messages.filter(message => message.role === "user").some(message => message.content.includes("Delegate to one child:"));
          let name, args;
          if (settled) {name = pick("final_result"); args = {response: "The requested operation is settled."};}
          else if (plan.targetInput.scenario === "question") {name = pick("AskUserQuestion"); args = {questions: [{id: "variant", prompt: "Which variant should be used?", options: [{label: "A", description: "Use variant A"}], allow_multiple: false}]};}
          else if (plan.targetInput.foreignReadPath) {name = pick("Read"); args = {file_path: plan.targetInput.foreignReadPath};}
          else if (delegate) {name = pick("Agent"); args = {description: "Append one isolated marker", prompt: "Append x once to effect.txt using the shell, then finish."};}
          else {
            name = pick(process.platform === "win32" ? "PowerShell" : "Bash");
            args = {command: process.platform === "win32" ? "[System.IO.File]::AppendAllText('effect.txt','x'); Write-Output 'effect recorded'" : "printf x >> effect.txt; printf 'effect recorded\\n'", timeout_ms: 10000, wait_ms: 10000};
          }
          if (!name) throw new Error("Controlled target did not expose the required callable");
          const result = {model: body.model, created_at: new Date().toISOString(), message: {role: "assistant", content: "", tool_calls: [{function: {name, arguments: args}}]},
            done: true, done_reason: "stop", prompt_eval_count: 1000, eval_count: 50};
          return {status:200,body:result};
    }});
  };
  const launch = async (scope, abort, mode) => {
    const number = ++launchNumber;
    const result = await runOwnedProcess(scope, {id: `electron-${mode}-${number}`, executable: electron,
      args: [targetFile, directory, mode, endpoint ?? "unused"], env: environment,
      log: join(directory, `${mode}-${number}.log`), signal: abort});
    if (result.code !== 0 && result.code !== 73) throw new Error(`evaluation_target_exit:${result.code}; see ${mode}-${number}.log`);
    return result;
  };
  const io = {
    store,
    environment: {
      async prepare(input, scope, abort) {
        const priorEffect = plan.startingState.construction.id === "isolated-local-effect-state";
        const contextTask=plan.startingState.construction.id==="isolated-context-task";
        if (plan.mode !== "actual_process" || plan.startingState.boundary !== "task_start" ||
          !["isolated-empty-workspace", "isolated-local-effect-state","isolated-context-task"].includes(plan.startingState.construction.id) ||
          plan.startingState.entries.some(entry => entry.disposition !== ((priorEffect && entry.facet === "completed_effects")||(contextTask&&entry.facet==="sources") ? "reconstructible" : "empty"))) throw new Error("unsupported_starting_state_constructor");
        await mkdir(join(directory, "workspace"), {recursive: true});
        const saved = await optionalJson(join(directory, "target-input.json"));
        if (saved && !sameProcessValue(saved, input)) throw new Error("target_input_binding_mismatch");
        if (!saved) await writeImmutable(join(directory, "target-input.json"), input);
        if(plan.targetInput.inspectionSettings&&!await optionalJson(join(directory,"inspection-settings.json")))
          await writeImmutable(join(directory,"inspection-settings.json"),{formatVersion:1,settings:plan.targetInput.inspectionSettings});
        if(contextTask){
          if(!Array.isArray(plan.targetInput.sourceFiles)||plan.targetInput.sourceFiles.length!==2)throw new Error("context_task_source_invalid");
          for(const [index,text] of plan.targetInput.sourceFiles.entries()){
            if(typeof text!=="string")throw new Error("context_task_source_invalid");
            const file=join(directory,"workspace",index===0?"evidence-a.txt":"evidence-b.txt"),prior=await readFile(file,"utf8").catch(e=>{if(e.code==="ENOENT")return null;throw e;});
            if(prior!==null&&prior!==text)throw new Error("initial_source_changed");if(prior===null)await writeFile(file,text,{flag:"wx"});
          }
        }
        if (priorEffect) {
          const file = join(directory, "workspace", "effect.txt");
          const existing = await readFile(file, "utf8").catch(error => {if (error.code === "ENOENT") return null; throw error;});
          if (existing !== null && existing !== "y") throw new Error("starting_effect_state_conflict");
          if (existing === null) await writeFile(file, "y", {flag: "wx"});
        }
        await mount(scope, abort);
        const binding = {projection: digest(input), environment: await rootIdentity(), endpoint};
        const original = await optionalJson(join(directory, "target-binding.json"));
        if (original && !sameProcessValue(original, binding)) throw new Error("original_target_binding_mismatch");
        if (!original) await writeImmutable(join(directory, "target-binding.json"), binding);
        return {startingStateRef: plan.startingState.ref, branch: corruptReceipt ? {...plan.branch, storageId: "foreign-storage"} : plan.branch,
          bindings: ref(`bindings:${digest(binding)}`), entries: plan.startingState.entries.map(entry => ({facet: entry.facet, owner: entry.owner,
            disposition: entry.disposition === "empty" ? "confirmed_empty" : "reconstructed", sourceEvidence: entry.evidence,
            evidence: entry.disposition === "empty" ? [] : [ref(contextTask?`source-boundary:${digest(plan.targetInput.sourceFiles)}`:`${plan.trial.ref.id}:local-effect-state`)]}))};
      },
      async verify(receipt, scope, abort) {
        if (reviewProcessStartingState(plan, receipt).length) throw new Error("invalid_original_start");
        const original = await loadJson(join(directory, "target-binding.json"));
        if (!sameProcessValue(original.environment, await rootIdentity()) || original.projection !== digest(projection) ||
          !sameProcessValue(await loadJson(join(directory, "target-input.json")), projection) || receipt.bindings.id !== `bindings:${digest(original)}`)
          throw new Error("original_target_binding_mismatch");
        const endpointRecord = await loadJson(join(directory, "endpoint.json"));
        if (`http://127.0.0.1:${endpointRecord.port}` !== original.endpoint) throw new Error("original_provider_endpoint_changed");
        return receipt;
      },
    },
    target: {
      async invoke(_input, receipt, scope, abort) {
        const completed = await optionalJson(join(directory, "target-result.json"));
        if (!completed && !endpoint) await mount(scope, abort);
        const result = completed ? {code: 0} : await launch(scope, abort, interruptAfterEffect ? "interrupt-after-effect" : "run");
        const actual = await loadJson(join(directory, "target-execution.json"));
        const outcome = await optionalJson(join(directory, "target-result.json"));
        return {status: result.code === 73 ? "interrupted" : outcome?.status === "completed" ? "completed" : "failed",
          bindings: receipt.bindings, executionRef: ref(actual.runId), evidence: [ref(`${actual.runId}:execution`)], reason: outcome?.cause ? JSON.stringify(outcome.cause) : null};
      },
      async cancel() {}, // Owned child process requests formal cancellation, then confirms exit.
    },
    async capture(record, scope, abort) {
      const startedAt = new Date().toISOString();
      const captureFile = location => readBranchFile(directory, location, plan.captureBounds.maxBytesPerSource);
      const actual = await optionalJson(join(directory, "target-execution.json"));
      const boundary = await optionalJson(join(directory, "target-result.json")) ?? await optionalJson(join(directory, "interruption.json"));
      const exportReceipt = boundary?.captureExport;
      const captured = exportReceipt?.status === "available" ? JSON.parse((await captureFile(exportReceipt.file)).toString()) : null;
      const interactions = await captureFile("interaction-events.jsonl").then(b => b.toString().trim().split("\n").filter(Boolean).map(JSON.parse))
        .catch(error => {if (error.code === "ENOENT") return []; throw error;});
      if (interactions.length > plan.captureBounds.maxRecordsPerSource ||
          Buffer.byteLength(JSON.stringify({captured, interactions})) > plan.captureBounds.maxBytesPerSource) throw new Error("execution_capture_bound");
      if (captured && (digest(captured) !== exportReceipt.digest || captured.generation !== boundary.generation || captured.rootRunId !== actual?.runId))
        throw new Error("execution_capture_binding_mismatch");
      const requests = await captureFile("provider-requests.jsonl").then(b => b.toString()).catch(error => {if (error.code === "ENOENT") return ""; throw error;});
      const responses = await captureFile("provider-responses.jsonl").then(b => b.toString()).catch(error => {if (error.code === "ENOENT") return ""; throw error;});
      if (Buffer.byteLength(requests) + Buffer.byteLength(responses) > plan.captureBounds.maxBytesPerSource) throw new Error("provider_capture_byte_bound");
      const requestRecords = requests.trim() ? requests.trim().split("\n").map(JSON.parse) : [];
      const responseRecords = responses.trim() ? responses.trim().split("\n").map(JSON.parse) : [];
      if (requestRecords.length + responseRecords.length > plan.captureBounds.maxRecordsPerSource) throw new Error("provider_capture_record_bound");
      const effect = await captureFile("workspace/effect.txt").then(b => b.toString()).catch(error => {if (error.code === "ENOENT") return ""; throw error;});
      const recordingEvents = await captureFile("recordings.jsonl").then(b => b.toString().trim().split("\n").map(JSON.parse))
        .catch(error => {if (error.code === "ENOENT") return []; throw error;});
      const recordings = [...new Map(recordingEvents.map((value, index) => [value.datasetId ? `${value.sourceId}:${value.datasetId}` : `unavailable:${index}`, value])).values()];
      const inspections = [];let metrics=null;
      let inspectorBytes = 0, inspectorRecords = 0;
      if (recordings.length) {
        const query = await scope.acquire("inspection-capture-query", "worker", async () => {
          const service = new InspectionQueryService(plan.targetInput.inspectionRoot??join(directory, "inspection"));
          return {id: "inspection-capture-query", kind: "worker", service:observedCaptureQuery(service,directory), close: () => service.close()};
        });
        for (const recording of recordings) {
          if (abort.aborted) throw new Error("capture_cancelled");
          if (!recording.sourceId) {inspections.push({...recording, complete: false}); continue;}
          const snapshot = await query.service.query({kind: "get_snapshot", sourceId: recording.sourceId, datasetId: recording.datasetId});
          let next, records = [], limited = false;
          do {
            if (abort.aborted) throw new Error("capture_cancelled");
            const page = await query.service.query({...snapshot.selection, kind: "list_records", runId: actual?.runId,
              includeDescendants: true, limit: 500, ...(next ? {after: next} : {})});
            for (const record of page.records) {
              const bytes = Buffer.byteLength(JSON.stringify(record));
              if (inspectorBytes + bytes > plan.captureBounds.maxBytesPerSource || inspectorRecords + 1 > plan.captureBounds.maxRecordsPerSource) {limited = true; break;}
              inspectorBytes += bytes; inspectorRecords++; records.push(record);
            }
            next = page.next;
          } while (next && !limited);
          const health = recording.health;
          inspections.push({...recording, selection: snapshot.selection, records, limited,
            complete: !limited && recording.phase === "closed" && records.length > 0 && health?.dropped === 0 && health.rejected === 0 && health.unpersisted === 0 && health.unconfirmed === 0});
        }
      }
      if(plan.targetInput.comparison==="C04"&&inspections.at(-1)?.selection&&captured?.members?.length){
        const metricQuery=await scope.acquire("comparison-metrics","worker",async()=>{const service=new InspectionQueryService(plan.targetInput.inspectionRoot??join(directory,"inspection"));return {id:"comparison-metrics",kind:"worker",service,close:()=>service.close()};});
        metrics=await captureComparisonMetrics(metricQuery.service,inspections,captured.members.map(m=>m.runId),abort);
      }
      const provider=plan.targetInput.comparison==="C04"?await captureFile("provider.jsonl").then(b=>b.toString().trim().split("\n").filter(Boolean).map(JSON.parse)).catch(e=>{if(e.code==="ENOENT")return [];throw e;}):[];
      const evidence = {trialId: plan.trial.ref.id, execution: captured, interactions, taskOutput:boundary?.output??null, requests: requestRecords,provider,
        serverPreparedResponses: responseRecords,metrics,
        effects: {bytes: effect, count: [...effect].filter(value => value === "x").length}, inspections};
      const captureRef = ref(`capture:${digest(evidence)}`);
      const evidenceFile = join(directory, `${captureRef.id.replace(":", "-")}.json`);
      if (!await optionalJson(evidenceFile)) await writeImmutable(evidenceFile, evidence);
      const inspectionComplete = inspections.length > 0 && inspections.every(value => value.complete);
      return assembleProcessCapture({plan, ref: captureRef, startedAt, completedAt: new Date().toISOString(), sources: [
        {owner: "execution", status: captured ? "complete" : interactions.length ? "partial" : "unavailable",
          refs: [...(captured ? [captured.treeRef] : []), ...(interactions.length ? [ref(`interactions:${digest(interactions)}`)] : [])],
          reason: captured ? null : "owner_snapshot_not_available"},
        {owner: "provider", status: requests ? "complete" : "unavailable", refs: requests ? [ref(`requests:${digest(requests)}`), ref(`server-responses:${digest(responses)}`)] : [], reason: requests ? null : "no_requests_captured"},
        {owner: "environment", status: "complete", refs: [ref(`effects:${digest(effect)}`)], reason: null},
        {owner: "inspector", status: inspectionComplete ? "complete" : inspections.some(value=>value.settings?.enabled!==false) ? "partial" : "unavailable",
          refs: inspections.filter(value => value.sourceId).map(value => ref(`${value.sourceId}:${value.datasetId}`, String(value.selection?.watermark ?? "unknown"))),
          reason: inspectionComplete ? null : inspections.length&&inspections.every(value=>value.settings?.enabled===false)?"recording_disabled":"recording_coverage_not_confirmed"},
      ]});
    },
    async assess(capture) {
      if (!capture) return [{claim: "effect_once", verdict: "insufficient_evidence", evidence: [], explanation: "No Capture"}];
      const evidence = await loadJson(join(directory, `${capture.ref.id.replace(":", "-")}.json`));
      const requests = JSON.stringify(evidence.requests);
      if(plan.targetInput.comparison==="C04"){
        const use=assessCapturedSubsequentUse(evidence,plan);
        return [{claim:"subsequent_use",...use,evidence:use.verdict==="insufficient_evidence"?[]:[capture.ref]},
          {claim:"private_inputs_withheld",verdict:!evidence.requests.length?"insufficient_evidence":requests.includes("private-source-facts")?"violated":"conforms",evidence:[capture.ref],explanation:"Actual task and child requests, not an intended projection"}];
      }
      return [
        {claim: "effect_once", verdict: !evidence.execution ? "insufficient_evidence" : evidence.effects.count === 1 ? "conforms" : "violated", evidence: [capture.ref], explanation: `Independent workspace effect count: ${evidence.effects.count}; original execution evidence: ${Boolean(evidence.execution)}`},
        {claim: "private_inputs_withheld", verdict: !evidence.requests.length ? "insufficient_evidence" : !requests.includes("PRIVATE_FUTURE_QUESTION_9b4f") && !requests.includes("private-effect-expectation") ? "conforms" : "violated",
          evidence: [capture.ref], explanation: "Actual encoded requests checked, not the planned projection"},
        {claim: "inspector_coverage", verdict: capture.sources.find(source => source.owner === "inspector").status === "complete" ? "conforms" : "insufficient_evidence",
          evidence: [capture.ref], explanation: "Inspector coverage is independent of execution-store coverage"},
      ];
    },
    async saveReport(report) {
      const result = ref(`report:${digest(report)}`);
      const file = join(directory, `${result.id.replace(":", "-")}.json`);
      if (!await optionalJson(file)) await writeImmutable(file, report);
      return result;
    },
  };
  return new EvaluationProcessExecution(io).run(plan, {signal, timeoutMs, cleanupTimeoutMs: 10000, captureTimeoutMs: 30000});
}
