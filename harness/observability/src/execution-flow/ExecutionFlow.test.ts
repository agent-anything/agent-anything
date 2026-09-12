import { describe, expect, it } from "vitest";
import { createExecutionFlowDefinition, validateExecutionFlowDefinition, ExecutionFlowPath, type ExecutionFlowObservation } from "./ExecutionFlow.js";

const definition = createExecutionFlowDefinition({owner:"test",id:"loop",revision:"1",label:"Test Loop",description:"Deterministic observation fixture",steps:[{id:"work",kind:"entry",label:"Work",checks:["ready"]},{id:"done",kind:"exit",label:"Done",checks:[]}],transitions:[{id:"repeat",from:"work",to:"work",label:"Continue"},{id:"finish",from:"work",to:"done",label:"Finish"}],entryStepIds:["work"],exitStepIds:["done"]});
describe("Execution flow observation", () => {
  it("retains exact repeat occurrences, caller identity, checks and immutable facts", () => {
    const facts: ExecutionFlowObservation[] = [];
    const root = new ExecutionFlowPath(definition,{observer:{observe:fact => {facts.push(fact);}}},"run");
    const first = root.advance("work");
    const basis = {ready:true}; first.check("ready","passed",basis); basis.ready=false;
    const child = new ExecutionFlowPath(definition,root.callContext,"run");
    child.advance("done"); child.close("returned");
    const second = root.advance("work"); root.advance("done"); root.close("returned"); root.close("failed");
    expect(first.ref.stepExecutionId).not.toBe(second.ref.stepExecutionId);
    expect(facts.find(fact => fact.kind === "constraint")).toMatchObject({basis:{ready:true}});
    expect(facts.filter(fact => fact.kind === "link")).toEqual(expect.arrayContaining([
      expect.objectContaining({relation:"call",from:first.ref,to:child.ref}),
      expect.objectContaining({relation:"return",to:first.ref}),
      expect.objectContaining({relation:"next",from:first.ref,to:second.ref,transitionId:"repeat"}),
    ]));
    expect(facts.filter(fact => fact.kind === "invocation_exited")).toHaveLength(2);
    expect(Object.isFrozen(facts[0])).toBe(true);
    expect(() => { (facts[0] as any).kind="wrong"; }).toThrow();
  });
  it("does not fabricate consumption when independently spawned work finishes", () => {
    const facts: ExecutionFlowObservation[]=[];
    const root = new ExecutionFlowPath(definition,{observer:{observe:value => {facts.push(value);}}},"parent");
    root.advance("work");
    const child = new ExecutionFlowPath(definition,{...root.callContext,relationship:"spawn"},"child");
    child.advance("done"); child.close("returned");
    expect(facts.some(fact => fact.kind === "link" && fact.relation === "spawn")).toBe(true);
    expect(facts.some(fact => fact.kind === "link" && ["join","return"].includes(fact.relation))).toBe(false);
  });
  it("does not freeze caller data or let observer failures escape", async () => {
    for (const observe of [() => {throw new Error("offline");}, () => Promise.reject(new Error("offline"))]) {
      const flow = new ExecutionFlowPath(definition,{observer:{observe}},"run");
      const source = {owner:"test",kind:"call",id:"call",revision:null};
      flow.advance("work",{},[source]); source.id="later"; flow.close("returned");
    }
    await Promise.resolve();
  });
  it("requires a bounded internally consistent captured definition and exact digest", () => {
    expect(() => validateExecutionFlowDefinition(definition)).not.toThrow();
    expect(createExecutionFlowDefinition({...definition})).toEqual(definition);
    expect(() => validateExecutionFlowDefinition({...definition,label:"Changed"})).toThrow("digest");
    expect(() => createExecutionFlowDefinition({...definition,entryStepIds:["missing"]})).toThrow();
    expect(() => createExecutionFlowDefinition({...definition,steps:Array(129).fill(definition.steps[0])})).toThrow();
    expect(() => createExecutionFlowDefinition({...definition,steps:[{...definition.steps[0]!,checks:["a","a"]},definition.steps[1]!]})).toThrow();
  });
});
