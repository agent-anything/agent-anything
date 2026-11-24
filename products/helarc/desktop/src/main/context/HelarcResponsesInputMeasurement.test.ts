import { describe, expect, it } from "vitest";
import { assessInputCapacity } from "@agent-anything/model-interaction/input";
import { interpretResponsesInputTokenCount, prepareResponses, prepareResponsesInputTokenCount } from "@agent-anything/provider-integrations/native";
import { bindResponsesRecipientMeasurements } from "./HelarcResponsesInputMeasurement.js";

const now = "2026-11-24T00:00:00.000Z";
const recipientInput = "parent:input";

function countRequest(arrangeCompaction: boolean) {
  const prepared = prepareResponses({
    model:"fixture", purpose:{id:"task",revision:"1"}, store:false, stream:true,
    tools:[{name:"inspect",description:"Read a rule",inputSchema:{type:"object",properties:{},additionalProperties:false}}],
    input:[
      {type:"compaction",encrypted_content:"opaque-prior-state"},
      {role:"user",content:"Inspect the current rule."},
      {type:"function_call",call_id:"call_1",name:"inspect",arguments:"{}"},
      {type:"function_call_output",call_id:"call_1",output:"Use B for new work only."},
      {role:"user",content:"Where does the correction apply?"}
    ],
    ...(arrangeCompaction ? {context_management:[{type:"compaction" as const,compact_threshold:13_500}]} : {})
  });
  return prepareResponsesInputTokenCount({prepared,binding:{
    encodedInputId:"count:" + prepared.digest, scope:{id:"scope",runId:"parent",recipient:"parent",purpose:"task"},
    selectionDigest:"selection",sourceDigest:"source",targetDigest:"target",targetRevision:"target:1",dependencyDigest:"dependencies",
    targetValidity:null,prefix:{kind:"none"},dependencies:{kind:"immutable",basis:"retained native replay"}
  }});
}

function decide(request: ReturnType<typeof countRequest>, tokens: number) {
  const body = JSON.stringify({object:"response.input_tokens",input_tokens:tokens});
  const receipt = interpretResponsesInputTokenCount(request,{
    status:200,requestId:"count",body,frames:[],work:{bytes:body.length,chunks:1,elapsedMs:1}
  },{operationId:"count:1",measuredAt:now});
  const evidence = bindResponsesRecipientMeasurements(request,receipt,{
    binding:request.binding,generationDigest:request.generation.digest,now,authorized:true,dependenciesAvailable:true
  },recipientInput,true);
  const admission = assessInputCapacity({encodedInputId:recipientInput,targetRevision:"target:1",purpose:"task",
    limits:[{id:"work",targetRevision:"target:1",dimension:"input_tokens",maximum:16_384,requires:"observed_input_count",source:"accepted_work_input_budget"}],
    evidence,reservations:[],policy:{id:"policy",revision:"1",purpose:"task",basis:"unknown model window permitted",allowEstimatedFit:true,allowUnknown:true}
  });
  return {evidence,admission};
}

describe("Responses complete-input work budget", () => {
  it("distinguishes replay of a compaction item from arranging compaction in this generation", () => {
    const replay = countRequest(false), arranged = countRequest(true);
    expect(replay.body.input).toEqual(replay.generation.body.input);
    expect(replay.body.tools).toEqual(replay.generation.body.tools);
    expect(arranged.encoded).toBe(replay.encoded);
    expect(arranged.generation.digest).not.toBe(replay.generation.digest);
    expect(decide(replay,14_800).admission.allowed).toBe(true);
    const {admission,evidence} = decide(arranged,14_800);
    expect(arranged.uncovered).toEqual(["field:context_management:create_field_not_in_count_schema"]);
    expect(evidence.find(e => e.dimension === "input_tokens")).toMatchObject({
      coverage:"partial",uncovered:expect.arrayContaining([...arranged.uncovered,"target_validity_unknown"])
    });
    expect(evidence.every(e => !e.observedInputCount)).toBe(true);
    expect(admission.allowed).toBe(false);
    expect(admission.decisions).toContainEqual(expect.objectContaining({limitId:"work",reason:"complete_count_required"}));
  });

  it.each([
    [16_384,true,"observed_count_within_work_budget"],
    [16_385,false,"observed_count_exceeds_work_budget"]
  ] as const)("applies the inclusive limit to the complete initial input: %i", (tokens,allowed,reason) => {
    const {admission,evidence} = decide(countRequest(false),tokens);
    expect(evidence.find(e => e.dimension === "input_tokens")?.observedInputCount?.tokens).toBe(tokens);
    expect(evidence.find(e => e.dimension === "shared_tokens")?.observedInputCount).toBeUndefined();
    expect(admission.allowed).toBe(allowed);
    expect(admission.decisions).toContainEqual(expect.objectContaining({limitId:"work",reason}));
  });
});
