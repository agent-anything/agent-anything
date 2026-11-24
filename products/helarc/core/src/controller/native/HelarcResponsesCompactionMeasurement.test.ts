import {describe,it,expect} from "vitest";
import {prepareResponses,prepareResponsesInputTokenCount,interpretResponsesInputTokenCount,unknownResponsesInputTokenCount} from "@agent-anything/provider-integrations/native";
import {helarcResponsesCompactionThreshold} from "./HelarcResponsesCompactionMeasurement.js";
const prepared=prepareResponses({model:"fixture",purpose:{id:"task",revision:"1"},input:[{role:"user",content:"original"}],stream:false,store:false,
  context_management:[{type:"compaction",compact_threshold:8000}]});
const request=prepareResponsesInputTokenCount({prepared,binding:{encodedInputId:"input",scope:{id:"scope",runId:"run",recipient:"task",purpose:"task"},selectionDigest:"selection",
  sourceDigest:"original",targetDigest:"target",dependencyDigest:"dependencies",targetRevision:"target:1",targetValidity:{basis:"configured",validUntil:"2027-01-01T00:00:00Z"},
  prefix:{kind:"none"},dependencies:{kind:"immutable",basis:"frozen"}}});
const result=interpretResponsesInputTokenCount(request,{status:200,requestId:"count",body:JSON.stringify({object:"response.input_tokens",input_tokens:9000}),frames:[],
  work:{bytes:55,chunks:1,elapsedMs:1}},{operationId:"count",measuredAt:"2026-11-15T00:00:00Z"});
const current={binding:request.binding,generationDigest:prepared.digest,now:"2026-11-15T00:00:01Z",authorized:true,dependenciesAvailable:true};
const args={request,result,current,tokens:8000,window:32000,headroom:4000,basis:"input pressure and measured source",acceptedUncertainty:"Explicit allowance for count schema coverage gap"};
describe("native compaction threshold evidence",()=>{
  it("carries the exact count binding and its uncovered fields, not a body-only token guess",()=>{
    const threshold=helarcResponsesCompactionThreshold(args);
    expect(threshold.measurement).toMatchObject({id:result.id,requestDigest:prepared.digest,coverage:"partial",tokens:9000});
    expect(threshold.measurement.unknowns).not.toEqual([]);
    expect(()=>helarcResponsesCompactionThreshold({...args,acceptedUncertainty:null})).toThrow("unjustified");
  });
  it("does not let an uncertainty allowance bypass changed scope, authority or expiry",()=>{
    for(const patch of [{authorized:false},{generationDigest:"changed"},{now:"2028-01-01T00:00:00Z"},{dependenciesAvailable:false}])
      expect(()=>helarcResponsesCompactionThreshold({...args,current:{...current,...patch}})).toThrow("not_applicable");
    expect(()=>helarcResponsesCompactionThreshold({...args,tokens:30000})).toThrow("unjustified");
  });
  it("keeps unknown measurement unknown",()=>{
    const result=unknownResponsesInputTokenCount(request,{operationId:"unknown",measuredAt:"2026-11-15T00:00:00Z",reason:"endpoint_unsupported",basis:"original unsupported response"});
    expect(helarcResponsesCompactionThreshold({...args,result}).measurement).toMatchObject({coverage:"unknown",tokens:null});
  });
});
