import {describe,expect,it} from "vitest";
import {assessInputCapacity} from "@agent-anything/model-interaction/input";
import {originalInputLimitationFacts} from "../context-representation/ContextInputUnavailability.js";
import {describeModelRequestInputFailure as explain} from "./ModelRequestInputFailure.js";

describe("model request input failure descriptions",()=>{
  it("uses the observed work-budget count, not the model window or an estimate",()=>{
    const scope={id:"scope",purpose:"task",runId:"run",recipient:"parent",continuity:"scope",owner:"owner",target:"model",authorityBasis:"auth"};
    const limits=[{id:"window",targetRevision:"model",dimension:"input_tokens",maximum:65536,source:"model"},
      {id:"work",targetRevision:"model",dimension:"input_tokens",maximum:16384,source:"task",requires:"observed_input_count"}] as const;
    const observation={id:"count",encodedInputId:"body",targetRevision:"model",methodRevision:"1",dimension:"input_tokens",coverage:"complete",
      quantity:{kind:"exact",value:20147},basis:"observed",uncovered:[]} as const;
    for(const counted of [true,false]){
      const measurements=[counted?{...observation,observedInputCount:{receiptId:"count-receipt",tokens:20147}}:observation];
      const assessment=assessInputCapacity({encodedInputId:"body",targetRevision:"model",purpose:"task",evidence:measurements,limits,reservations:[],
        policy:{id:"policy",revision:"1",purpose:"task",basis:"work",allowEstimatedFit:false,allowUnknown:false}});
      const facts=originalInputLimitationFacts({kind:"recipient_prepared",capacity:{inputId:"body",assessment,limits,measurements},
        allowed:assessment.allowed,scope,inputId:"body",bodyDigest:"body",exactInputDigest:"selected",judgmentId:"assessed",risks:[],
        evidence:{owner:"owner",kind:"judgment",id:"assessed",revision:"1"}});
      if(counted)expect(facts.workInputBudget).toEqual({measuredTokens:20147,maximumTokens:16384});
      else expect(facts).toEqual({originalBlock:"required_count_missing"});
    }
  });
  it.each([
    ["replacement_count_exhausted","no more input replacements"],
    ["replacement_deadline_elapsed","deadline"],
    ["replacement_count_and_deadline_exhausted","allowance was exhausted, and"],
    ["remote_measurement_dependency_unavailable","could not be requested"],
    ["remote_measurement_result_invalid","returned a result"],
    ["admission_rejected:activity_schedule_resource_unavailable","exceeds the pool's total capacity"],
    ["admission_rejected:activity_schedule_claim_exceeds_pool_capacity","exceeds the pool's total capacity"],
    ["admission_rejected:activity_schedule_pool_missing","missing"],
    ["automatic_preparation_disabled","disabled"],
  ])("describes %s",(reason,part)=>expect(explain({reason})).toContain(part));
  it("distinguishes a missing permission from a publication deadline",()=>{
    const reason="original_source_unavailable";
    expect(explain({limitation:{reason,sourceStop:"authorization"}})).toContain("denied authorization");
    expect(explain({limitation:{reason,sourceStop:"deadline"}})).toContain("deadline passed");
  });
  it.each([
    ["plan_attribution","assessment plan could not establish"],
    ["plan_scope","assessment plan could not establish"],
    ["candidate_contradiction","answer contradicted"],
    ["evidence_insufficient","did not establish that the required information was preserved"],
  ])("explains a non-adopted result from its own evidence: %s",(category,message)=>{
    const summary=explain({limitation:{reason:"original_path_requires_bounded_revision",preservationUnconfirmed:true,assessmentIssues:[category]}});
    expect(summary).toContain(message);expect(summary).toContain("no supported replacement");
    expect(summary).not.toMatch(/authorize|retry|try again/i);
  });
  it("does not interpolate unknown reasons, invent a count, or presume a compaction failure",()=>{
    const limitation={reason:"input_encoding_unsupported:/private/history",workInputBudget:{measuredTokens:-1,maximumTokens:100}};
    expect(explain({limitation})).toBe("The model protocol cannot encode the recorded input in its original form.");
    expect(explain({reason:"private payload"})).toBe("No usable input could be prepared for this model request.");
  });
});
