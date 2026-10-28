import {describe, expect, it} from "vitest";
import {ActivityPurposeRegistry, type ActivityPurposeContract} from "./ActivityPurpose.js";
import {validateActivityPath, validateActivityStage} from "./ActivityHandoff.js";

const contract: ActivityPurposeContract = {ref:{id:"generation",revision:"1"},inputOwner:"context",executionOwner:"model",
  interpretationOwner:"method",acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["generate"],capabilities:["read"],continuationKinds:["stage_request"]};
describe("trusted activity purpose", () => {
  it("routes identical output by original binding, not response shape", () => {
    const registry = new ActivityPurposeRegistry<(output: unknown) => string>();
    const generation = registry.register(contract, () => "candidate");
    const task = registry.register({...contract,ref:{id:"task",revision:"1"},interpretationOwner:"task"}, () => "decision");
    const output = {tool_calls:[{name:"final_result"}]};
    expect(registry.resolve(generation)(output)).toBe("candidate");
    expect(registry.resolve(task)(output)).toBe("decision");
    expect(() => registry.resolve({...generation, contract:{...generation.contract,interpretationOwner:"task"}})).toThrow("unavailable");
    expect(() => new ActivityPurposeRegistry().resolve(generation)).toThrow("unavailable");
  });
  it("retains immutable registration and bounds delegated capabilities and dependencies", () => {
    const registry = new ActivityPurposeRegistry<null>();
    const purpose = registry.register(contract,null);
    const path = {id:"path",runId:"child",owner:"method",purpose,permissionBasis:"permissions:1",resourceScope:"preparation",
      maximumStages:3,maximumAttempts:4,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
    validateActivityPath(path);
    const request = {id:"stage",pathId:"path",stageKind:"generate",input:{source:"exact"},capabilities:["read"],dependencies:[]};
    validateActivityStage(request,path);
    expect(() => validateActivityStage({...request,capabilities:["write"]},path)).toThrow("not_delegated");
    expect(() => validateActivityStage({...request,dependencies:[{requestId:"stage",condition:"accepted"}]},path)).toThrow("dependency");
    expect(() => validateActivityPath({...path,maximumStages:Infinity})).toThrow("bound");
  });
});
