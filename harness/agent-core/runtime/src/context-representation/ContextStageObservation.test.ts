import {expect,it} from "vitest";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityPathState,ActivityStageState} from "../activity/ActivityHandoff.js";
import {TASK_MODEL_RESPONSE_PURPOSE} from "../decision/TaskModelResponsePath.js";
import {taskModelStageObservation} from "../decision/TaskModelStageObservation.js";
import {contextStageObservation} from "./ContextStageObservation.js";
import {contextActivityFactObservation} from "./ContextActivityFactObservation.js";
import {REPRESENTATION_METHOD_PURPOSE} from "./methods/RepresentationMethod.js";

const purpose={contract:TASK_MODEL_RESPONSE_PURPOSE,digest:modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)};
const path={intent:{id:"path",runId:"child",purpose}} as ActivityPathState;
const stage={request:{id:"stage",pathId:"path",input:{kind:"task_model_source",request:{requestId:"original"}}},result:null,receipt:null} as ActivityStageState;
it("does not invent per-stage resource use from a cumulative method snapshot",()=>{
  const methodPurpose={contract:REPRESENTATION_METHOD_PURPOSE,digest:modelInputValueDigest(REPRESENTATION_METHOD_PURPOSE)};
  const observation=contextStageObservation({...path,intent:{...path.intent,purpose:methodPurpose}},
    {...stage,receipt:{progress:{method:{request:{},readBytes:9000,storedBytes:2000,assessments:[]}}}} as ActivityStageState);
  expect(observation.method?.resourcesDelta).toEqual({readBytes:null,storedBytes:null});
});
it("binds public source evidence to original purpose, Run and snapshot revision",()=>{
  const observation=taskModelStageObservation(path,stage);
  expect(observation.source?.requestId).toBe("original");expect(observation.scope).toMatchObject({runId:"child",pathId:"path",stageId:"stage",purpose,revision:modelInputValueDigest(stage)});
  expect(observation.delivery).toBeNull();expect(observation.presentation).toBeNull();
});
it("rejects wrong scope and changed purpose rather than inspecting a similar payload",()=>{
  const changed={...path,intent:{...path.intent,id:"parent"}};
  expect(()=>contextStageObservation(changed,stage)).toThrow("scope_invalid");
  expect(()=>taskModelStageObservation(changed,stage)).toThrow("scope_invalid");
  expect(()=>contextStageObservation({...path,intent:{...path.intent,purpose:{...purpose,digest:"changed"}}},stage)).toThrow("scope_invalid");
  const unrelated={...purpose.contract,interpretationOwner:"unrelated"};
  expect(taskModelStageObservation({...path,intent:{...path.intent,purpose:{contract:unrelated,digest:modelInputValueDigest(unrelated)}}},stage).source).toBeNull();
});
it("does not reconstruct an acceptance from a publication revision",()=>{
  const observation=contextActivityFactObservation({sequence:1,runId:"child",pathId:"source",requestId:null,kind:"fact_published",occurredAt:"2026-11-01T00:00:00Z",
    details:{fact:{id:"publication",sourceId:"source",ref:{owner:"context-representation",kind:"result_settled",id:"stage",revision:"not-an-acceptance"}}}});
  expect(observation.links).toEqual([]);expect(observation.closure).toBeNull();
});
