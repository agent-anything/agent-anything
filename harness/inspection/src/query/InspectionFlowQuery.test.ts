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
