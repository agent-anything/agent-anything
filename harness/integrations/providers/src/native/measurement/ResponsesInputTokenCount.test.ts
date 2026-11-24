import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import { digest, type JsonObject } from "../NativeJson.js";
import { prepareResponses } from "../OpenAIResponses.js";
import type { NativeHttpObservation } from "../NativeHttp.js";
import { prepareResponsesInputTokenCount, dispatchResponsesInputTokenCount, restoreResponsesInputTokenCount,
  responsesMeasurementInvalidation, type ResponsesMeasurementBinding, type ResponsesMeasurementApplicability,
  type ResponsesInputTokenCountRequest } from "./ResponsesInputTokenCount.js";
import { interpretResponsesInputTokenCount, restoreResponsesCountEvidence, reuseResponsesInputTokenCount,
  unknownResponsesInputTokenCount } from "./ResponsesCountEvidence.js";
import { assessResponsesInputCapacity, responsesInputCapacityEvidence, responsesInputCapacityRefusal } from "./ResponsesCapacityBridge.js";

const measuredAt = "2026-11-13T01:00:00.000Z", now = "2026-11-13T01:00:01.000Z";
function binding(patch: Partial<ResponsesMeasurementBinding> = {}): ResponsesMeasurementBinding {
  return { encodedInputId:"prepared:1", scope:{id:"scope:parent", runId:"parent", recipient:"parent", purpose:"task"},
    selectionDigest:"selection:1", sourceDigest:"sources:1", targetDigest:"target:account1", dependencyDigest:"dependencies:1", targetRevision:"target:1",
    targetValidity:{basis:"configured-model-revision", validUntil:"2026-11-14T00:00:00.000Z"},
    prefix:{kind:"none"}, dependencies:{kind:"immutable", basis:"versioned-native-content"}, ...patch };
}
function prepare(body: JsonObject = {model:"fixture", input:[{role:"user", content:"task"}], stream:true, store:false},
  value = binding()): ResponsesInputTokenCountRequest {
  return prepareResponsesInputTokenCount({ prepared:{body, encoded:JSON.stringify(body), digest:digest(body)}, binding:value });
}
function current(request: ResponsesInputTokenCountRequest, patch: Partial<ResponsesMeasurementApplicability> = {}): ResponsesMeasurementApplicability {
  return {binding:request.binding, generationDigest:request.generation.digest, now, authorized:true, dependenciesAvailable:true, ...patch};
}
function observation(body: unknown = {object:"response.input_tokens", input_tokens:51}, status = 200): NativeHttpObservation {
  return {status, requestId:"http:count", body:JSON.stringify(body), frames:[], work:{bytes:50, chunks:1, elapsedMs:7}};
}
function measure(request: ResponsesInputTokenCountRequest, count = 51) {
  return interpretResponsesInputTokenCount(request, observation({object:"response.input_tokens", input_tokens:count}), {operationId:"count:1", measuredAt});
}
const policy = {id:"policy", revision:"1", purpose:"task", basis:"fixture scoped policy", allowEstimatedFit:false, allowUnknown:false};
afterEach(() => {vi.restoreAllMocks();vi.useRealTimers();});

describe("Responses full-input count mapping", () => {
  it("counts the exact native mapped catalog, instructions, settings and ordered native groups", () => {
    const prepared = prepareResponses({model:"fixture", purpose:{id:"task", revision:"1"}, stream:true, store:false,
      input:[{role:"user",content:"task"},{id:"reasoning", type:"reasoning", summary:[], encrypted_content:"opaque"},
        {type:"function_call", call_id:"call:1", name:"tool", arguments:"{}"},
        {type:"function_call_output", call_id:"call:1", output:"denied"}], instructions:"Enabled instructions",
      reasoning:{effort:"high", context:"all_turns"}, include:["reasoning.encrypted_content"],
      tools:[{name:"tool", description:"Actual contract", inputSchema:{type:"object", properties:{optional:{type:"string"}}, additionalProperties:false}}]});
    const request = prepareResponsesInputTokenCount({prepared, binding:binding()});
    expect(request.body).toEqual({model:"fixture", input:prepared.body.input, instructions:"Enabled instructions",
      reasoning:{effort:"high",context:"all_turns"}, tools:prepared.body.tools, tool_choice:"auto", parallel_tool_calls:true});
    expect(request.body.tools).toEqual([{type:"function", name:"tool", description:"Actual contract", strict:true,
      parameters:{type:"object",properties:{optional:{anyOf:[{type:"string"},{type:"null"}],
        description:"null means the property was not supplied. Empty values remain supplied values."}},required:["optional"],additionalProperties:false}}]);
    expect(request.coverage).toBe("complete");
    expect(request.generation.encoded).toBe(prepared.encoded);
    expect(request.mappings.find(item => item.field === "include")).toMatchObject({disposition:"measurement_neutral"});
    expect(Object.isFrozen(request.body.input)).toBe(true);
  });
  it("does not restore disabled instructions or insert an output limit or accounting text", () => {
    const request = prepare();
    expect(request.body).toEqual({model:"fixture",input:[{role:"user",content:"task"}]});
    expect(request.encoded).not.toContain("max_output_tokens");
    expect(request.encoded).not.toContain("instructions");
    expect(request.encoded).not.toContain("2026");
  });
  it("preserves text formatting, explicit empty instructions, personality and disabled truncation", () => {
    const body = {model:"fixture", input:[], instructions:"", text:{format:{type:"json_schema",name:"result",schema:{type:"object"}}},
      personality:"pragmatic", truncation:"disabled"};
    expect(prepare(body).body).toEqual(body);
    expect(() => prepare({...body,truncation:"auto"})).toThrow("responses_count_truncation_forbidden");
  });
  it("declares create-only options uncovered, never silently exact", () => {
    const body = {model:"fixture", input:[], context_management:[{type:"compaction",compact_threshold:1000}], max_output_tokens:33, image:{context_compression:"enabled"}};
    const request = prepare(body);
    expect(request.generation.body).toEqual(body);
    expect(request.body).toEqual({model:"fixture",input:[]});
    expect(request.coverage).toBe("partial");
    const evidence = responsesInputCapacityEvidence(request,measure(request,1000),current(request));
    expect(evidence.quantity.kind).toBe("unknown");
    expect(evidence.uncovered).toHaveLength(3);
    expect(assessResponsesInputCapacity({request,result:measure(request,1000),current:current(request),policy,reservations:[],
      limits:[{id:"input",dimension:"input_tokens",targetRevision:"target:1",maximum:20,source:"configured"}]}).decisions[0].conclusion).toBe("uncertain");
  });
  it.each(["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"])("binds %s and preserves native breakpoints without claiming unsupported equivalence", field => {
    const marker = {type:"input_text",text:"stable prefix",prompt_cache_breakpoint:{mode:"explicit",ttl:"12h"}};
    const values: JsonObject = {prompt_cache_key:"opaque-key", prompt_cache_retention:"24h", prompt_cache_options:{mode:"explicit",ttl:"12h"}};
    const request = prepare({model:"fixture",input:[{role:"user",content:[marker]}],[field]:values[field]});
    expect(request.body.input).toEqual([{role:"user",content:[marker]}]);
    expect(request.body).not.toHaveProperty(field);
    expect(request.mappings.find(item => item.field === field)).toMatchObject({disposition:"uncovered",basis:"cache_count_equivalence_unestablished"});
    expect(responsesInputCapacityEvidence(request,measure(request),current(request)).quantity.kind).toBe("unknown");
  });
  it("covers a persistent prefix only with exact remote coverage evidence", () => {
    const body = {model:"fixture", previous_response_id:"resp:long", input:[{role:"user",content:"short suffix"}]};
    const request = prepare(body,binding({prefix:{kind:"persistent",responseId:"resp:long",coverageDigest:"scope/generation/prefix:1"}}));
    expect(request.body).toEqual(body);
    expect(request.coverage).toBe("complete");
    const partial = prepare(body,binding({prefix:{kind:"persistent",responseId:"resp:long",coverageDigest:null}}));
    expect(partial.uncovered).toContain("remote_prefix_coverage_unknown");
    expect(responsesInputCapacityEvidence(partial,measure(partial),current(partial)).quantity.kind).toBe("unknown");
    expect(() => prepare(body)).toThrow("responses_count_prefix_mismatch");
    expect(() => prepare({...body,conversation:"conversation:1"})).toThrow("responses_count_conversation_unsupported");
  });
  it.each(["conversation:1", {id:"conversation:1"}, null])("rejects remote Conversations outside A01: %j", conversation => {
    expect(() => prepare({model:"fixture",conversation,input:[]})).toThrow("responses_count_conversation_unsupported");
  });
  it("cannot count connection-memory state by opening another connection", async () => {
    const request = prepare({model:"fixture",previous_response_id:"resp:socket",input:[]},binding({prefix:{kind:"connection_memory",responseId:"resp:socket"}}));
    const fetcher = vi.fn();
    await expect(dispatchResponsesInputTokenCount(request,{baseUrl:"https://fixture.invalid/v1",apiKey:"fixture",targetDigest:request.binding.targetDigest},
      {signal:new AbortController().signal,fetch:fetcher,retainChunk:async()=>{},applicability:current(request)})).rejects.toThrow("connection_memory_not_countable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("mutable and unverified external resolutions cannot establish reusable complete counts", () => {
    for (const kind of ["mutable","unknown"] as const) {
      const request = prepare({model:"fixture",input:[{role:"user",content:[{type:"input_image",image_url:"https://fixture.invalid/latest.png"}]}]},
        binding({dependencies:{kind,reason:"external resolution not versioned"}}));
      const result = measure(request);
      expect(result.status).toBe("measured");
      expect(reuseResponsesInputTokenCount(request,result,current(request))).toMatchObject({reusable:false});
      expect(responsesInputCapacityEvidence(request,result,current(request)).quantity.kind).toBe("unknown");
    }
  });
  it("rejects corrupt generation or restored mappings", () => {
    const request = prepare();
    expect(() => prepareResponsesInputTokenCount({prepared:{...request.generation,encoded:"{}"},binding:request.binding})).toThrow("responses_count_generation_changed");
    expect(() => restoreResponsesInputTokenCount({...request,body:{model:"other"}})).toThrow("responses_count_request_corrupt");
    expect(() => restoreResponsesInputTokenCount({...request,coverage:"partial"})).toThrow("responses_count_request_corrupt");
  });
  it("restores canonical stored evidence without changing original generation/count bytes or ordered mappings", () => {
    const request = prepare({model:"fixture", input:[{role:"user",content:"task"}], reasoning:{effort:"low"}, stream:true, store:false});
    const retained = snapshotModelJsonValue(request,"count evidence") as unknown as ResponsesInputTokenCountRequest;
    expect(JSON.stringify(retained.generation.body)).not.toBe(request.generation.encoded);
    const restored = restoreResponsesInputTokenCount(retained);
    expect(restored).toEqual(request);
    expect(restored.id).toBe(request.id);
    expect(restored.generation.encoded).toBe(request.generation.encoded);
    expect(restored.encoded).toBe(request.encoded);
    expect(restored.mappings).toEqual(request.mappings);
  });
});

describe("Responses count evidence and original-work reuse", () => {
  it.each([0,51])("retains explicit count %i with no invented breakdown or usage", count => {
    const request = prepare(), result = measure(request,count);
    expect(result).toMatchObject({status:"measured",inputTokens:count,precision:"exact_for_count_payload",operationId:"count:1"});
    expect(result.raw).toEqual({object:"response.input_tokens",input_tokens:count});
    expect(result).not.toHaveProperty("usage");
    expect(responsesInputCapacityEvidence(request,result,current(request)).quantity).toEqual({kind:"exact",value:count});
  });
  it.each([undefined,-1,0.5,"2",Number.MAX_SAFE_INTEGER+1])("never turns malformed count %s into a number", value => {
    const request = prepare();
    expect(interpretResponsesInputTokenCount(request,observation({object:"response.input_tokens",input_tokens:value}),{operationId:"count:1",measuredAt}))
      .toMatchObject({status:"unknown",reason:"invalid_response"});
  });
  it.each([
    [401,null,null,"authentication"],[403,null,null,"authorization"],[429,null,null,"rate_limited"],
    [400,"context_length_exceeded",null,"overflow"],[400,"invalid_request",null,"invalid_request"],
    [404,null,"previous_response_id","dependency_unavailable"],[404,null,"input[0].file_id","dependency_unavailable"],[404,null,null,"other"],
  ])("distinguishes refusal %s/%s/%s", (status,code,param,category) => {
    const request = prepare();
    const result = interpretResponsesInputTokenCount(request,observation({error:{code,param}},Number(status)),{operationId:"count:1",measuredAt});
    expect(result).toMatchObject({status:"refused",category});
    expect(responsesInputCapacityEvidence(request,result,current(request)).quantity.kind).toBe("unknown");
  });
  it("keeps capability unsupported, network uncertainty and service failure distinct", () => {
    const request = prepare();
    for (const reason of ["endpoint_unsupported","transport_failure","outcome_unknown","cancelled"] as const) {
      const result = unknownResponsesInputTokenCount(request,{reason,basis:"original operation/capability evidence",operationId:"count:1",measuredAt});
      expect(result).toMatchObject({status:"unknown",reason,observation:null});
      expect(restoreResponsesCountEvidence(request,JSON.parse(JSON.stringify(result)))).toEqual(result);
    }
    expect(interpretResponsesInputTokenCount(request,observation({error:{message:"unavailable"}},503),{operationId:"count:1",measuredAt}))
      .toMatchObject({status:"unknown",reason:"service_unavailable"});
  });
  it("recovers exact evidence without a new count and rejects altered retained values", () => {
    const request = prepare(), result = measure(request);
    const restored = restoreResponsesInputTokenCount(JSON.parse(JSON.stringify(request)));
    const retained = restoreResponsesCountEvidence(restored,JSON.parse(JSON.stringify(result)));
    expect(reuseResponsesInputTokenCount(restored,retained,current(restored))).toMatchObject({reusable:true,evidence:result});
    expect(() => restoreResponsesCountEvidence(request,{...result,inputTokens:7} as typeof result)).toThrow("responses_count_evidence_corrupt");
    expect(() => restoreResponsesCountEvidence(request,{...result,requestId:"other"})).toThrow("responses_count_evidence_binding_changed");
  });
  it.each(["selectionDigest","sourceDigest","targetDigest","dependencyDigest","targetRevision"] as const)("invalidates %s independently of wire bytes", field => {
    const request = prepare(), result = measure(request);
    const changed = current(request,{binding:{...request.binding,[field]:"changed"}});
    expect(reuseResponsesInputTokenCount(request,result,changed)).toMatchObject({reusable:false,reasons:["binding_changed"]});
  });
  it.each(["instructions","tools","text","reasoning","personality","prompt_cache_key"])("invalidates changed native %s", field => {
    const request = prepare(), changed = prepare({...request.generation.body,[field]:"changed"});
    expect(responsesMeasurementInvalidation(request,current(request,{generationDigest:changed.generation.digest}))).toContain("generation_changed");
  });
  it("rechecks target validity, availability, recipient authority and time", () => {
    const request = prepare(), result = measure(request);
    expect(reuseResponsesInputTokenCount(request,result,current(request,{authorized:false})).reasons).toContain("authorization_unavailable");
    expect(reuseResponsesInputTokenCount(request,result,current(request,{dependenciesAvailable:false})).reasons).toContain("dependency_unavailable");
    expect(reuseResponsesInputTokenCount(request,result,current(request,{now:"2026-11-14T00:00:00Z"})).reasons).toContain("target_validity_expired");
    expect(reuseResponsesInputTokenCount(request,result,current(request,{now:"2026-11-12T00:00:00Z"})).reasons).toContain("measurement_from_future");
    const uncertain = prepare(undefined,binding({targetValidity:null}));
    expect(reuseResponsesInputTokenCount(uncertain,measure(uncertain),current(uncertain)).reasons).toContain("target_validity_unknown");
  });
  it("keeps a complete count as a limited estimate when only target validity is unknown",()=>{
    const request=prepare(undefined,binding({targetValidity:null})),result=measure(request,51);
    const evidence=responsesInputCapacityEvidence(request,result,current(request));
    expect(evidence).toMatchObject({coverage:"complete",quantity:{kind:"estimate",value:51},uncovered:[]});
    expect(evidence.quantity.kind==="estimate"&&evidence.quantity.limitations).toContain("target_validity_unknown");
    expect(reuseResponsesInputTokenCount(request,result,current(request)).reusable).toBe(false);
    const input={request,result,current:current(request),reservations:[],
      limits:[{id:"input",dimension:"input_tokens" as const,targetRevision:"target:1",maximum:100,source:"fixture"}]};
    expect(assessResponsesInputCapacity({...input,policy}).allowed).toBe(false);
    expect(assessResponsesInputCapacity({...input,policy:{...policy,allowEstimatedFit:true}}).decisions[0]?.conclusion).toBe("estimated_fit");
    for(const conditions of [current(request,{authorized:false}),current(request,{dependenciesAvailable:false}),
      current(request,{generationDigest:"changed"})])
      expect(responsesInputCapacityEvidence(request,result,conditions).quantity.kind).toBe("unknown");
  });
  it("WA05 repeats observation without input serialization, encoding or remote work", () => {
    const request = prepare({model:"fixture",input:[{role:"user",content:"long prefix ".repeat(10000)}]}), result = measure(request);
    const stringify = vi.spyOn(JSON,"stringify");
    for (let revision=0; revision<100; revision++) {
      const state = {...current(request), uiRevision:revision, pendingSiblingRevision:revision};
      expect(reuseResponsesInputTokenCount(request,result,state).evidence).toBe(result);
      expect(responsesInputCapacityEvidence(request,result,state).quantity).toEqual({kind:"exact",value:51});
    }
    expect(stringify.mock.calls.some(([value]) => value === request.generation.body || value === request.body || value === request)).toBe(false);
    expect(stringify.mock.results.every(result => typeof result.value !== "string" || result.value.length < 4000)).toBe(true);
    expect(request.binding.selectionDigest).toBe("selection:1");
  });
  it("Parent and Child never pool window counts or accept each other's measurement", () => {
    const parent = prepare(), child = prepare(undefined,binding({scope:{id:"scope:child",runId:"child",recipient:"child",purpose:"task"},encodedInputId:"prepared:child"}));
    const parentResult = measure(parent), childResult = measure(child,900);
    expect(parent.id).not.toBe(child.id);
    expect(() => responsesInputCapacityEvidence(child,parentResult,current(child))).toThrow("responses_count_evidence_binding_changed");
    expect(responsesInputCapacityEvidence(parent,parentResult,current(parent)).quantity).toEqual({kind:"exact",value:51});
    expect(responsesInputCapacityEvidence(child,childResult,current(child)).quantity).toEqual({kind:"exact",value:900});
  });
});

describe("native measurement transport and capacity bridge", () => {
  it("sends one bounded count POST, retains bytes, and cannot advance task progress", async () => {
    const request = prepare(), retained:Uint8Array[] = [], before = JSON.stringify(request);
    const fetcher = vi.fn(async () => new Response('{"object":"response.input_tokens","input_tokens":51}',{status:200,headers:{"x-request-id":"count:request"}}));
    const result = await dispatchResponsesInputTokenCount(request,{baseUrl:"https://fixture.invalid/v1",apiKey:"fixture-only",targetDigest:request.binding.targetDigest},
      {signal:new AbortController().signal,fetch:fetcher,applicability:current(request),retainChunk:async bytes => {retained.push(bytes);}});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://fixture.invalid/v1/responses/input_tokens");
    const init = (fetcher.mock.calls[0] as unknown as [unknown,RequestInit])[1];
    expect(init.method).toBe("POST");expect(init.body).toBe(request.encoded);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Buffer.concat(retained).toString("utf8")).toBe(result.body);
    expect(result.requestId).toBe("count:request");
    expect(JSON.stringify(request)).toBe(before);
  });
  it("does not retry failures or dispatch after cancellation/revocation/target change", async () => {
    const request = prepare(), connection = {baseUrl:"https://fixture.invalid/v1",apiKey:"fixture",targetDigest:request.binding.targetDigest};
    const fetcher = vi.fn(async () => {throw new Error("network failed");});
    const options = {signal:new AbortController().signal,fetch:fetcher,applicability:current(request),retainChunk:async()=>{}};
    await expect(dispatchResponsesInputTokenCount(request,connection,options)).rejects.toThrow("network failed");
    expect(fetcher).toHaveBeenCalledTimes(1);fetcher.mockClear();
    await expect(dispatchResponsesInputTokenCount(request,connection,{...options,signal:AbortSignal.abort()})).rejects.toThrow();
    await expect(dispatchResponsesInputTokenCount(request,connection,{...options,applicability:current(request,{authorized:false})})).rejects.toThrow("responses_count_not_authorized");
    await expect(dispatchResponsesInputTokenCount(request,{...connection,targetDigest:"different"},options)).rejects.toThrow("responses_count_target_changed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds connection wait without a retry or a response-cancel request", async () => {
    vi.useFakeTimers();
    const request = prepare(), deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal,"timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn((_url:unknown, init?:RequestInit) => new Promise<Response>((_resolve,reject) => {
      init!.signal!.addEventListener("abort",() => reject(init!.signal!.reason),{once:true});
    }));
    const work = dispatchResponsesInputTokenCount(request,{baseUrl:"https://fixture.invalid/v1",apiKey:"fixture",targetDigest:request.binding.targetDigest},
      {signal:new AbortController().signal,fetch:fetcher,applicability:current(request),retainChunk:async()=>{}});
    const rejected = expect(work).rejects.toThrow("responses_count_connection_timeout");
    await vi.advanceTimersByTimeAsync(15000);await rejected;
    expect(timeout).toHaveBeenCalledWith(30000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends a stalled response at the one-shot deadline and releases its reader", async () => {
    const request = prepare(), deadline = new AbortController(), cancelled = vi.fn(), retained = vi.fn(async()=>{});
    vi.spyOn(AbortSignal,"timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {controller.enqueue(new TextEncoder().encode('{"object":'));}, cancel:cancelled,
    })));
    const work = dispatchResponsesInputTokenCount(request,{baseUrl:"https://fixture.invalid/v1",apiKey:"fixture",targetDigest:request.binding.targetDigest},
      {signal:new AbortController().signal,fetch:fetcher,applicability:current(request),retainChunk:retained});
    const rejected = expect(work).rejects.toThrow("fixture deadline");
    await vi.waitFor(() => expect(retained).toHaveBeenCalledTimes(1));
    deadline.abort(new Error("fixture deadline"));await rejected;
    expect(cancelled).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not return an unretained count when custody fails", async () => {
    const request = prepare(), fetcher = vi.fn(async () => new Response('{"object":"response.input_tokens","input_tokens":0}'));
    await expect(dispatchResponsesInputTokenCount(request,{baseUrl:"https://fixture.invalid/v1",apiKey:"fixture",targetDigest:request.binding.targetDigest},
      {signal:new AbortController().signal,fetch:fetcher,applicability:current(request),retainChunk:async()=>{throw new Error("custody failed");}}))
      .rejects.toThrow("custody failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("feeds exact/overflow/unknown generation planning into existing scoped assessment", () => {
    const request = prepare(), result = measure(request,80), state = current(request);
    const base = {request,result,current:state,policy,reservations:[],limits:[{id:"window",dimension:"shared_tokens" as const,targetRevision:"target:1",maximum:100,source:"configured"}]};
    const unknown = assessResponsesInputCapacity(base);
    expect(unknown.allowed).toBe(false);expect(unknown.decisions[0].conclusion).toBe("uncertain");
    const planned = assessResponsesInputCapacity({...base,reservations:[{id:"generation",purpose:"generation",dimension:"shared_tokens",quantity:{kind:"bounds",lower:0,upper:15},basis:"purpose estimate bound",alreadyIncluded:false}]});
    expect(planned.allowed).toBe(true);
    const overflow = assessResponsesInputCapacity({...base,result:measure(request,101)});
    expect(overflow.allowed).toBe(false);expect(overflow.decisions[0].conclusion).toBe("violated");
    expect(request.generation.body).not.toHaveProperty("max_output_tokens");
    expect(request.body).not.toHaveProperty("max_output_tokens");
  });
  it("does not let allowUnknown overrule a current explicit native overflow", () => {
    const request = prepare(), result = interpretResponsesInputTokenCount(request,
      observation({error:{code:"context_length_exceeded",param:"input"}},400),{operationId:"count:overflow",measuredAt});
    const state = current(request), scoped = {...policy,allowUnknown:true};
    const evidence = responsesInputCapacityEvidence(request,result,state);
    expect(evidence.quantity.kind).toBe("unknown");
    const base = {request,result,current:state,policy:scoped,reservations:[],
      limits:[{id:"input",dimension:"input_tokens" as const,targetRevision:"target:1",maximum:100,source:"configured"}]};
    const assessment = assessResponsesInputCapacity(base);
    expect(assessment.refusals).toEqual([responsesInputCapacityRefusal(request,result,state)]);
    expect(assessment.allowed).toBe(false);
    expect(assessment.decisions).toContainEqual({limitId:"responses_count_admissibility",evidenceId:result.id,conclusion:"violated",
      reason:"bound_native_count_refused:context_length_exceeded"});
    expect(assessResponsesInputCapacity({...base,limits:[]}).allowed).toBe(false);
    const stale = assessResponsesInputCapacity({...base,current:current(request,{now:"2026-11-14T00:00:00Z"})});
    expect(stale).not.toHaveProperty("refusals");
    expect(stale.decisions.some(item => item.conclusion === "violated")).toBe(false);
    const changed = assessResponsesInputCapacity({...base,current:current(request,{binding:{...request.binding,dependencyDigest:"changed"}})});
    expect(changed.decisions.some(item => item.conclusion === "violated")).toBe(false);
    const ordinary = interpretResponsesInputTokenCount(request,observation({error:{code:"invalid_request"}},400),{operationId:"count:other",measuredAt});
    expect(assessResponsesInputCapacity({...base,result:ordinary}).allowed).toBe(true);
  });
  it.each([
    {context_management:[{type:"compaction",compact_threshold:1000}]},
    {image:{context_compression:"enabled"}},
    {prompt_cache_options:{mode:"explicit",ttl:"12h"}},
  ])("leaves partial-mapping overflow to scoped unknown policy: %j", fields => {
    const request = prepare({model:"fixture",input:[{role:"user",content:"task"}],...fields}),
      result = interpretResponsesInputTokenCount(request,observation({error:{code:"context_length_exceeded",param:"input"}},400),
        {operationId:"count:partial-overflow",measuredAt});
    expect(request.coverage).toBe("partial");
    expect(result).toMatchObject({status:"refused",category:"overflow",errorCode:"context_length_exceeded"});
    expect(responsesInputCapacityRefusal(request,result,current(request))).toBeNull();
    const evidence = responsesInputCapacityEvidence(request,result,current(request));
    expect(evidence.quantity.kind).toBe("unknown");
    expect(evidence.uncovered).toContain("refused:overflow");
    for (const allowUnknown of [false,true]) {
      const assessment = assessResponsesInputCapacity({request,result,current:current(request),policy:{...policy,allowUnknown},reservations:[],
        limits:[{id:"input",dimension:"input_tokens",targetRevision:"target:1",maximum:100,source:"configured"}]});
      expect(assessment.allowed).toBe(allowUnknown);
      expect(assessment.decisions).toHaveLength(1);
      expect(assessment.decisions[0].conclusion).toBe("uncertain");
      expect(assessment.decisions.some(item => item.limitId === "responses_count_admissibility")).toBe(false);
    }
  });
});
