import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createExecutionFlowDefinition, ExecutionFlowPath, type ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";
import { InspectionRecorder } from "../../dist/recording/index.js";
import { InspectionQueryService } from "../../dist/query/index.js";
import { ExecutionFlowInspectionAdapter } from "../../dist/adapters/index.js";

const dispose: (() => Promise<void>)[]=[];
afterEach(async () => {for (const close of dispose.splice(0).reverse()) await close();});
const definition = createExecutionFlowDefinition({owner:"test",id:"loop",revision:"1",label:"Recorded Loop",description:"Repeated captured steps",steps:[{id:"work",label:"Work",kind:"entry",checks:["ready"]},{id:"finish",label:"Finish",kind:"exit",checks:[]}],transitions:[{id:"repeat",from:"work",to:"work",label:"Continue"},{id:"finish",from:"work",to:"finish",label:"Finish"}],entryStepIds:["work"],exitStepIds:["finish"]});
async function setup() {
  const root=mkdtempSync(join(tmpdir(),"flow-inspection-"));
  dispose.push(async () => {if(!relative(tmpdir(),resolve(root)).startsWith("flow-inspection-")) throw new Error("Invalid cleanup target");rmSync(root,{recursive:true,force:true});});
  const recorder=await InspectionRecorder.create({root,application:"test",name:"Flow fixture"});
  const query=new InspectionQueryService(root);
  dispose.push(async()=>query.close()); dispose.push(async()=>recorder.flush(true));
  const adapter=new ExecutionFlowInspectionAdapter(recorder);
  const selection={sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId};
  const snapshot=async()=>{await recorder.flush();return (await query.query({kind:"get_snapshot",...selection})).selection!;};
  return {recorder,adapter,query,snapshot};
}

describe("Recorded execution flow queries",()=>{
  it("persists owner-local material under content policy with exact input/output references", async () => {
    const {adapter, query, snapshot} = await setup();
    const flow = new ExecutionFlowPath(definition, {observer: adapter}, "run");
    const source = {answer: 42};
    const input = flow.material("Owner input", "received", source);
    const step = flow.advance("work", {}, [input]);
    step.check("ready", "passed");
    const output = flow.material("Owner output", "produced", {answer: 84}, "execution");
    step.output(output);
    source.answer = -1;
    flow.advance("finish"); flow.close("returned");
    const scope = await snapshot();
    const detail = await query.query({...scope, kind: "get_flow_occurrence", runId: "run", invocationId: flow.ref.invocationId, occurrenceId: step.ref.stepExecutionId!});
    const refs = detail.flow!.occurrence!.references;
    expect(refs).toHaveLength(2);
    expect(refs.every(ref => ref.availability === "present")).toBe(true);
    for (const ref of refs) {
      const subject = {...scope, owner: "test", kind: "contribution" as const, id: ref.role === "input" ? input.id : output.id, runId: "run", revision: "1"};
      const records = await query.query({...scope, kind: "get_subject", subject});
      expect(records.records[0]?.contents[0]).toMatchObject({class: ref.role === "input" ? "agent" : "execution", availability: "not_captured"});
    }
  });
  it("distinguishes pending checks, explicit short circuits and missing closed-step facts", async () => {
    const {adapter, query, snapshot} = await setup();
    const flow = new ExecutionFlowPath(definition, {observer: adapter}, "run");
    const first = flow.advance("work");
    const selection = {kind: "get_flow_occurrence" as const, runId: "run", invocationId: flow.ref.invocationId, occurrenceId: first.ref.stepExecutionId!};
    const open = await query.query({...await snapshot(), ...selection});
    expect(open.flow?.occurrence).toMatchObject({status: "open", checks: [{id: "ready", availability: "pending", recordIds: []}]});
    flow.advance("work").check("ready", "not_evaluated", {reason: "cancelled_before_check"});
    flow.advance("finish"); flow.close("cancelled");
    const closed = await query.query({...await snapshot(), ...selection, limit: 1});
    expect(closed.flow?.occurrence).toMatchObject({status: "closed", checks: [{id: "ready", availability: "not_observed", recordIds: []}]});
    expect(closed.limitations).toContain("flow_check_not_observed");
    // Reading a limited page must not change occurrence-level coverage.
    expect(closed.flow?.occurrence).toEqual((await query.query({...await snapshot(), ...selection})).flow?.occurrence);
    const skipped = (await query.query({...await snapshot(), kind: "list_flow_occurrences", runId: "run", invocationId: flow.ref.invocationId})).records[1]!;
    const detail = await query.query({...await snapshot(), ...selection, occurrenceId: skipped.subject.id});
    expect(detail.flow?.occurrence?.checks[0]?.availability).toBe("recorded");
    expect(detail.limitations).not.toContain("flow_check_not_observed");
  });
  it("resolves versioned forward references, preserves unversioned use-time state and exposes unmapped refs", async () => {
    const {adapter, recorder, query, snapshot} = await setup();
    const source = recorder.ref("test", "context", "context", "run");
    const offer = (id: string) => recorder.offer({id, subject: source, occurredAt: null, payload: {kind: "event", name: id, sequence: null, code: null}});
    offer("before");
    const flow = new ExecutionFlowPath(definition, {observer: adapter}, "run");
    const ref = {owner: "test", kind: "contribution", id: "output", revision: "1"};
    const step = flow.advance("work", {}, [
      {owner: "test", kind: "context", id: "context", revision: null},
      {owner: "retry", kind: "attempt", id: "late-attempt", revision: null},
    ]);
    step.check("ready", "passed", {required: 1, available: 2}, ref);
    step.output(ref, {owner: "test", kind: "unsupported-domain-kind", id: "unknown", revision: null});
    flow.advance("finish"); flow.close("returned");
    const old = await snapshot();
    offer("later");
    recorder.offer({id: "late-attempt-record", subject: recorder.ref("retry", "attempt", "late-attempt", "run"), occurredAt: null,
      payload: {kind: "event", name: "retry_attempt_started", sequence: null, code: null}});
    recorder.offer({id: "output-record", subject: recorder.ref(ref.owner, "contribution", ref.id, "run", ref.revision), occurredAt: null,
      payload: {kind: "event", name: "produced", sequence: null, code: null},
      contents: [{name: "Result", class: "definition", stage: "produced", mediaType: "application/json", value: {answer: 42}}]});
    recorder.offer({id: "output-linked", subject: recorder.ref(ref.owner, "contribution", ref.id, "run", ref.revision), occurredAt: null,
      payload: {kind: "event", name: "linked-after-material", sequence: null, code: null}});
    const current = await snapshot();
    const selection = {kind: "get_flow_occurrence" as const, runId: "run", invocationId: flow.ref.invocationId, occurrenceId: step.ref.stepExecutionId!};
    const before = await query.query({...old, ...selection});
    const after = await query.query({...current, ...selection});
    expect(before.flow?.occurrence?.references.find(item => item.role === "output")?.availability).toBe("not_observed");
    expect(after.flow?.occurrence?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({role: "input", availability: "present", recordId: "before"}),
      expect.objectContaining({role: "input", availability: "observed_later", recordId: "late-attempt-record"}),
      expect.objectContaining({role: "output", availability: "present", recordId: "output-record"}),
      expect.objectContaining({role: "configuration", availability: "present", recordId: "output-record"}),
      expect.objectContaining({role: "output", availability: "unmapped", recordId: null}),
    ]));
    expect(after.limitations).toContain("flow_reference_unmapped");
    expect(after.limitations).toContain("flow_reference_only_observed_later");
    const diagnostic = await query.query({...current, kind: "list_records", recordKind: "event"});
    expect(diagnostic.records.some(record => record.payload.kind === "event" && record.payload.code === "inspection_flow_reference_unmapped")).toBe(true);
    expect((await query.query({...old, ...selection})).flow?.occurrence).toEqual(before.flow?.occurrence);
  });
  it("does not label an unclosed step active after its invocation has ended", async () => {
    const {adapter, query, snapshot} = await setup();
    const flow = new ExecutionFlowPath(definition, {observer: adapter}, "run");
    const step = flow.enter("work");
    flow.close("failed");
    const detail = await query.query({...await snapshot(), kind: "get_flow_occurrence", runId: "run", invocationId: flow.ref.invocationId, occurrenceId: step.ref.stepExecutionId!});
    expect(detail.flow?.occurrence?.status).toBe("incomplete");
    expect(detail.limitations).toContain("flow_exit_not_observed");
  });
  it("keeps open occurrences and exact call/return links at their capture watermark",async()=>{
    const {adapter,query,snapshot}=await setup();
    const root=new ExecutionFlowPath(definition,{observer:adapter},"run");
    const first=root.advance("work");first.check("ready","passed",{revision:1});
    const before=await snapshot();
    const child=new ExecutionFlowPath(definition,root.callContext,"run");child.advance("finish");child.close("returned");
    const second=root.advance("work");root.advance("finish");root.close("returned");
    const after=await snapshot();
    const beforeFlow=await query.query({...before,kind:"get_execution_flow",runId:"run",invocationId:root.ref.invocationId});
    expect(beforeFlow.flow?.definition).toEqual(definition);
    expect(beforeFlow.flow?.steps).toEqual([{stepId:"work",visits:1,exits:0,failed:0}]);
    const later=await query.query({...after,kind:"get_execution_flow",runId:"run",invocationId:root.ref.invocationId});
    expect(later.flow?.steps).toContainEqual({stepId:"work",visits:2,exits:2,failed:0});
    expect(later.flow?.transitions).toContainEqual({transitionId:"repeat",traversals:1});
    const occurrence=await query.query({...after,kind:"get_flow_occurrence",runId:"run",invocationId:root.ref.invocationId,occurrenceId:first.ref.stepExecutionId!});
    expect(occurrence.records.some(record=>record.payload.kind==="flow_constraint")).toBe(true);
    expect(occurrence.flow?.links).toEqual(expect.arrayContaining([expect.objectContaining({kind:"call",to:expect.objectContaining({id:child.ref.invocationId})}),expect.objectContaining({kind:"return"}),expect.objectContaining({kind:"next",to:expect.objectContaining({id:second.ref.stepExecutionId})})]));
    expect((await query.query({...before,kind:"get_flow_occurrence",runId:"run",invocationId:root.ref.invocationId,occurrenceId:first.ref.stepExecutionId!})).records.some(record=>record.payload.kind==="flow_step"&&record.payload.observation.kind==="step_exited")).toBe(false);
  });
  it("binds pagination to Run, invocation, filter and watermark",async()=>{
    const {adapter,query,snapshot}=await setup();
    const flow=new ExecutionFlowPath(definition,{observer:adapter},"run");
    for(let i=0;i<7;i++) flow.advance("work");flow.advance("finish");flow.close("returned");
    const scope=await snapshot();
    const base={...scope,kind:"list_flow_occurrences" as const,runId:"run",invocationId:flow.ref.invocationId,limit:2};
    const first=await query.query(base);
    expect(first.records).toHaveLength(2);
    const second=await query.query({...base,cursor:String(first.next)});
    expect(second.records).toHaveLength(2);expect(second.records[0]?.id).not.toBe(first.records[0]?.id);
    for(const change of [{runId:"other"},{invocationId:"other"},{stepId:"work"},{watermark:scope.watermark-1}]) {
      await expect(query.query({...base,...change,cursor:String(first.next)})).rejects.toThrow("inspection_cursor_invalid");
    }
  });
  it("does not stop recording when one flow contradicts its captured definition",async()=>{
    const {adapter,query,snapshot,recorder}=await setup();
    const flow=new ExecutionFlowPath(definition,{observer:adapter},"run");
    flow.advance("work");flow.advance("not-declared");flow.close("returned");
    recorder.offer({id:"after-invalid",subject:recorder.ref("runtime","run","run","run"),occurredAt:null,payload:{kind:"event",name:"still recorded",sequence:1,code:null}});
    const scope=await snapshot();
    const coverage=(await query.query({...scope,kind:"get_snapshot"})).coverage!;
    expect(coverage.rejected).toBeGreaterThan(0);
    expect(coverage.limitations).toContain("inspection_flow_step_invalid");
    expect((await query.query({...scope,kind:"get_record",recordId:"after-invalid"})).records).toHaveLength(1);
    expect(recorder.health().available).toBe(true);
  });
  it("never substitutes a later definition for missing capture at an older watermark",async()=>{
    const {adapter,query,snapshot}=await setup();
    const buffered: ExecutionFlowObservation[]=[];
    const flow=new ExecutionFlowPath(definition,{observer:{observe:fact=>{buffered.push(fact);if(fact.kind!=="definition")adapter.observe(fact);}}},"run");
    flow.advance("work");
    const old=await snapshot();adapter.observe(buffered[0]!);const latest=await snapshot();
    const queryFor={kind:"get_execution_flow" as const,runId:"run",invocationId:flow.ref.invocationId};
    expect((await query.query({...old,...queryFor})).flow?.definition).toBeNull();
    expect((await query.query({...latest,...queryFor})).flow?.definition).toEqual(definition);
    expect((await query.query({...old,...queryFor})).limitations).toContain("flow_definition_not_observed");
  });
});
