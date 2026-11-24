import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_RESPONSES, OLLAMA_CHAT } from "@agent-anything/model-interaction/protocol";
import { prepareResponses } from "../OpenAIResponses.js";
import { digest, type JsonObject } from "../NativeJson.js";
import { bindNativeInputManifest, nativeInputGroupDigest, nativeInputSettings, type NativeInputGroup, type NativeInputManifest } from "../input/NativeInputManifest.js";
import { realizeResponsesInput, reserveResponsesInput, acceptResponsesContinuation, responsesOutputGroup,
  type ResponsesContinuation, type ResponsesInputRealization } from "../input/ResponsesInputRealization.js";
import { buildResponsesMeasurementBinding, responsesMeasurementApplicabilityFromRealization,
  type ResponsesMeasurementBindingInput, type ResponsesMeasurementCurrentConditions } from "./ResponsesMeasurementBinding.js";
import { prepareResponsesInputTokenCount, restoreResponsesInputTokenCount } from "./ResponsesInputTokenCount.js";
import { interpretResponsesInputTokenCount, reuseResponsesInputTokenCount } from "./ResponsesCountEvidence.js";

const purpose = {id:"task",revision:"1"}, request = {model:"fixture",purpose,stream:false};
const conditions = {basis:"authority:preparation",authorized:true,disclosureRevision:"disclosure:1",remoteStorage:true,
  targetSupport:"established" as const,predecessor:"available" as const,reestablish:true,policyChange:false};
const now = "2026-11-13T01:00:01.000Z";
function group(id:string, items:readonly JsonObject[]): NativeInputGroup {
  return {id,representation:{id:`rep:${id}`,revision:"1"},sources:[`source:${id}:1`],holds:[`hold:${id}:1`],deliveries:[],requires:[],items,replay:"local"};
}
const user = group("user",[{role:"user",content:"Inspect only."}]);
const answer = group("answer",[{id:"msg:1",type:"message",role:"assistant",content:[{type:"output_text",text:"Inspected."}]}]);
const followup = group("followup",[{role:"user",content:"Explain the result."}]);
function manifest(groups:readonly NativeInputGroup[] = [user], changes:Partial<NativeInputManifest> = {},
  req:Parameters<typeof prepareResponses>[0] = {...request,input:[],store:true}):NativeInputManifest {
  const settings = nativeInputSettings(prepareResponses(req).body);
  return bindNativeInputManifest({protocol:OPENAI_RESPONSES,scope:{id:"task:parent",runId:"parent",recipientId:"parent",purpose,compositionDigest:"composition:1"},
    target:{model:req.model,configuration:"configuration:1",connection:"account:1",disclosure:"disclosure:1"},
    selection:{id:"selection:1",revision:"1",boundary:"boundary:1",judgments:["judgment:1"]},groups,settings,
    settingSources:Object.keys(settings).map(field => ({field,source:`source:setting:${field}`,digest:digest(settings[field])})),...changes});
}
function realize(m = manifest(), previous:ResponsesContinuation|null = null,
  req:Omit<Parameters<typeof prepareResponses>[0],"input"|"store"|"previous_response_id"> = request):ResponsesInputRealization {
  return realizeResponsesInput({manifest:m,request:req,policy:"persistent_chain",previous,
    conditions:{...conditions,disclosureRevision:m.target.disclosure}});
}
function head():ResponsesContinuation {
  const first = realize();
  return acceptResponsesContinuation({pending:reserveResponsesInput(first,"generate:1"),manifest:first.manifest,operationId:"generate:1",
    observation:answer.sources[0],outputGroup:answer,response:{id:"resp:1",object:"response",status:"completed",output:answer.items}});
}
function input(realization = realize()):ResponsesMeasurementBindingInput {
  return {manifest:realization.manifest,realization,targetValidity:{basis:"model-snapshot-facts:1",validUntil:"2026-12-01T00:00:00.000Z"},
    dependencies:{revision:"rendering:1",resolution:{kind:"immutable",basis:"versioned-selected-content:1"}}};
}
function current(value:ResponsesMeasurementBindingInput):ResponsesMeasurementCurrentConditions {
  const lease = {basis:"current-scope-check",checkedAt:"2026-11-13T01:00:00.000Z",validUntil:"2026-11-13T01:05:00.000Z"};
  return {now,manifestDigest:value.manifest.digest,authority:{...lease,authorized:true},dependencies:{...lease,available:true}};
}
function count(value:ResponsesMeasurementBindingInput) {
  const request = prepareResponsesInputTokenCount({prepared:value.realization.prepared,binding:buildResponsesMeasurementBinding(value)});
  const result = interpretResponsesInputTokenCount(request,{status:200,requestId:"http:1",body:'{"object":"response.input_tokens","input_tokens":73}',
    frames:[],work:{bytes:52,chunks:1,elapsedMs:1}},{operationId:"count:1",measuredAt:"2026-11-13T01:00:00.000Z"});
  return {request,result};
}
afterEach(() => vi.restoreAllMocks());

describe("manifest to Responses measurement binding", () => {
  it("binds complete native input and scope without accepting or reserving a task response", () => {
    const value = input(), before = digest(value.realization), binding = buildResponsesMeasurementBinding(value);
    expect(binding.scope).toEqual({id:"task:parent",runId:"parent",recipient:"parent",purpose:"task"});
    expect(binding.targetDigest).toBe(digest(value.manifest.target));
    expect(binding.targetRevision).toBe("configuration:1");
    expect(binding.prefix).toEqual({kind:"none"});
    expect(Object.isFrozen(binding)).toBe(true);
    const measured = count(value);
    expect(measured.request.body).toEqual({model:"fixture",input:[{role:"user",content:"Inspect only."}]});
    expect(measured.request.body).not.toHaveProperty("max_output_tokens");
    expect(measured.request.body).not.toHaveProperty("instructions");
    expect(digest(value.realization)).toBe(before);expect(value.realization.next.pending).toBeNull();
  });
  it("proves the selected persistent prefix, not just the short transmitted suffix", () => {
    const realization = realize(manifest([user,answer,followup]),head()), value = input(realization);
    const binding = buildResponsesMeasurementBinding(value), measured = count(value);
    expect(realization.prefixGroups).toBe(2);
    expect(binding.prefix).toMatchObject({kind:"persistent",responseId:"resp:1",coverageDigest:expect.stringMatching(/^sha256:/)});
    expect(measured.request.body.input).toEqual(followup.items);
    expect(measured.request.body.previous_response_id).toBe("resp:1");
    expect(measured.request.coverage).toBe("complete");
    const forged = {...realization,next:{...realization.next,response:{...realization.next.response!,coverage:[{id:"user",digest:"wrong"}]}}};
    expect(() => buildResponsesMeasurementBinding(input(forged))).toThrow("responses_measurement_continuity_mismatch");
  });
  it("validates an explicit full replay without inheriting a predecessor", () => {
    const m = manifest([user,answer],{}, {...request,input:[],store:false});
    const realization = realizeResponsesInput({manifest:m,request,policy:"native_replay",previous:head(),conditions:{...conditions,policyChange:true}});
    const binding = buildResponsesMeasurementBinding(input(realization));
    expect(binding.prefix).toEqual({kind:"none"});expect(realization.prepared.body.input).toEqual([...user.items,...answer.items]);
  });
  it("counts remote-only reasoning inside a proven multi-item prefix without requiring local ciphertext", () => {
    const multi = {...user,items:[...user.items,{role:"user",content:"Retain the inspection constraints."}]};
    const first = realize(manifest([multi]));
    const response = {id:"resp:remote",object:"response",status:"completed",output:[...answer.items,
      {id:"reasoning:remote",type:"reasoning",summary:[]}]};
    const remote = responsesOutputGroup({manifest:first.manifest,response,observation:"remote:observation",id:"remote",
      representation:{id:"remote-representation",revision:"1"},holds:["remote:hold"]});
    expect(remote.replay).toBe("remote_only");
    const previous = acceptResponsesContinuation({pending:reserveResponsesInput(first,"generate:remote"),manifest:first.manifest,
      operationId:"generate:remote",response,observation:"remote:observation",outputGroup:remote});
    const realization = realize(manifest([multi,remote,followup]),previous), value = input(realization);
    expect(realization.prefixGroups).toBe(2);
    expect(realization.manifest.groups.slice(0,2).flatMap(g => g.items)).toHaveLength(4);
    const measured = count(value);
    expect(measured.request.coverage).toBe("complete");
    expect(measured.request.body.input).toEqual(followup.items);
    expect(measured.request.body.previous_response_id).toBe("resp:remote");
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,
      responsesMeasurementApplicabilityFromRealization(value,current(value))).reusable).toBe(true);
    const replayManifest = manifest([multi,remote,followup],{}, {...request,input:[],store:false});
    expect(() => realizeResponsesInput({manifest:replayManifest,request,policy:"native_replay",previous,
      conditions:{...conditions,policyChange:true}})).toThrow("responses_replay_material_unavailable");
    expect(() => realizeResponsesInput({manifest:realization.manifest,request,policy:"persistent_chain",previous,
      conditions:{...conditions,predecessor:"unavailable"}})).toThrow("responses_replay_material_unavailable");
    const {previous_response_id:_previous,...settings} = realization.prepared.body;
    const body = {...settings,input:realization.manifest.groups.flatMap(g => g.items)};
    const forged = {...realization,path:"reestablish" as const,predecessor:null,prefixGroups:0,
      next:{...realization.next,generation:realization.next.generation+1,response:null},
      prepared:{...realization.prepared,body,digest:digest(body),encoded:JSON.stringify(body)}};
    expect(() => buildResponsesMeasurementBinding(input(forged))).toThrow("responses_measurement_continuity_mismatch");
  });
  it("does not hash renewal of holds, delivery receipts or continuation observations into input identity", () => {
    const original = input(realize(manifest([user,answer,followup]),head()));
    const renewedGroups = original.manifest.groups.map(g => ({...g,holds:[`renewed:${g.id}`],deliveries:[`receipt:${g.id}`]}));
    const prior = head();
    const renewed = input(realize(manifest(renewedGroups),{...prior,revision:prior.revision+10,
      response:{...prior.response!,observation:"new-observation-of-same-response"}}));
    expect(renewed.manifest.digest).not.toBe(original.manifest.digest);
    expect(buildResponsesMeasurementBinding(renewed)).toEqual(buildResponsesMeasurementBinding(original));
    const measured = count(original);
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,
      responsesMeasurementApplicabilityFromRealization(renewed,current(renewed))).reusable).toBe(true);
    expect(() => responsesMeasurementApplicabilityFromRealization(renewed,current(original))).toThrow("responses_measurement_conditions_scope_changed");
  });
  it.each(["id","revision","judgments"] as const)("reuses numerical evidence across selection %s updates only with current manifest authority", field => {
    const original = input(), oldBinding = buildResponsesMeasurementBinding(original), measured = count(original);
    const selection = {...original.manifest.selection,...(field === "judgments" ? {judgments:["renewed-preservation-judgment"]} : {[field]:"renewed"})};
    const renewed = input(realize(manifest([{...user,holds:["renewed:hold"],deliveries:["renewed:receipt"]}],{selection})));
    expect(renewed.manifest.digest).not.toBe(original.manifest.digest);
    expect(buildResponsesMeasurementBinding(renewed)).toEqual(oldBinding);
    expect(() => responsesMeasurementApplicabilityFromRealization(renewed,current(original))).toThrow("responses_measurement_conditions_scope_changed");
    const checked = responsesMeasurementApplicabilityFromRealization(renewed,current(renewed));
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,checked).reusable).toBe(true);
    const revoked = {...current(renewed),authority:{...current(renewed).authority,authorized:false}};
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,
      responsesMeasurementApplicabilityFromRealization(renewed,revoked)).reasons).toContain("authorization_unavailable");
    expect(measured.request.binding).toEqual(oldBinding);
  });
  it("retains the finite input boundary even when current wire text is unchanged", () => {
    const original = input(), changed = input(realize(manifest([user],{selection:{...original.manifest.selection,boundary:"boundary:2"}})));
    expect(changed.realization.prepared.encoded).toBe(original.realization.prepared.encoded);
    expect(buildResponsesMeasurementBinding(changed).selectionDigest).not.toBe(buildResponsesMeasurementBinding(original).selectionDigest);
  });
  it.each(["items","representation","sources"] as const)("invalidates selected %s even when a remote wire suffix is unchanged", field => {
    const original = input(realize(manifest([user,answer,followup]),head()));
    const changed = {...user,...(field === "items" ? {items:[{role:"user",content:"Different original input."}]} :
      field === "representation" ? {representation:{...user.representation,revision:"2"}} : {sources:["source:user:2"]})};
    const m = manifest([changed,answer,followup]);
    const prior = head();
    // Independent fixture: same remote identifier with different selected coverage must not reuse a count.
    const revisedHead = {...prior,response:{...prior.response!,coverage:[changed,answer].map(g => ({id:g.id,digest:nativeInputGroupDigest(g)}))}};
    const revised = input(realize(m,revisedHead));
    expect(revised.realization.prepared.body).toEqual(original.realization.prepared.body);
    expect(buildResponsesMeasurementBinding(revised).selectionDigest).not.toBe(buildResponsesMeasurementBinding(original).selectionDigest);
    expect(buildResponsesMeasurementBinding(revised).dependencyDigest).not.toBe(buildResponsesMeasurementBinding(original).dependencyDigest);
    const measured = count(original);
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,
      responsesMeasurementApplicabilityFromRealization(revised,current(revised))).reasons).toContain("binding_changed");
  });
  it.each(["model","configuration","connection","disclosure"] as const)("invalidates target %s", field => {
    const original = input(), target = {...original.manifest.target,[field]:"changed"};
    const req = {...request,model:target.model};
    const revised = input(realize(manifest([user],{target},{...req,input:[],store:true}),null,req));
    expect(buildResponsesMeasurementBinding(revised).targetDigest).not.toBe(buildResponsesMeasurementBinding(original).targetDigest);
  });
  it.each(["instructions","reasoning","tools"] as const)("binds changes to actual %s and its native mapping", field => {
    const original = input();
    const changedRequest = {...request,...(field === "instructions" ? {instructions:"Explicit enabled instruction"} : field === "reasoning" ?
      {reasoning:{effort:"high"}} : {tools:[{name:"inspect",description:"Inspect",inputSchema:{type:"object",properties:{},additionalProperties:false}}]})};
    const revised = input(realize(manifest([user],{}, {...changedRequest,input:[],store:true}),null,changedRequest));
    expect(buildResponsesMeasurementBinding(revised).encodedInputId).not.toBe(buildResponsesMeasurementBinding(original).encodedInputId);
    expect(buildResponsesMeasurementBinding(revised).sourceDigest).not.toBe(buildResponsesMeasurementBinding(original).sourceDigest);
    const measured = count(original);
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,
      responsesMeasurementApplicabilityFromRealization(revised,current(revised))).reasons).toContain("generation_changed");
  });
  it("keeps Parent, Child, purpose revision and composition bindings independent", () => {
    const original = input(), originalBinding = buildResponsesMeasurementBinding(original);
    for (const scope of [
      {...original.manifest.scope,id:"task:child",runId:"child",recipientId:"child"},
      {...original.manifest.scope,purpose:{id:"task",revision:"2"}},
      {...original.manifest.scope,compositionDigest:"composition:2"},
    ]) {
      const revised = input(realize(manifest([user],{scope})));
      expect(buildResponsesMeasurementBinding(revised).encodedInputId).not.toBe(originalBinding.encodedInputId);
    }
  });
  it("invalidates dependency versions and continuation generations, not ledger revisions", () => {
    const original = input(realize(manifest([user,answer,followup]),head())), originalBinding = buildResponsesMeasurementBinding(original);
    const revised = {...original,dependencies:{...original.dependencies,revision:"rendering:2"}};
    expect(buildResponsesMeasurementBinding(revised).dependencyDigest).not.toBe(originalBinding.dependencyDigest);
    const prior = head(), generation = input(realize(original.manifest,{...prior,generation:prior.generation+1}));
    expect(buildResponsesMeasurementBinding(generation).dependencyDigest).not.toBe(originalBinding.dependencyDigest);
  });
  it.each(["path","reason","predecessor","prefixGroups","expectedRevision","next","conditionBasis"] as const)(
    "rejects a forged %s against the original resolved continuity plan", field => {
      const original = realize(manifest([user,answer,followup]),head());
      const changes = {path:"establish",reason:"forged",predecessor:"resp:forged",prefixGroups:1,
        expectedRevision:original.expectedRevision+1,next:{...original.next,generation:original.next.generation+1},conditionBasis:"forged-basis"};
      const forged = {...original,[field]:changes[field]} as ResponsesInputRealization;
      expect(() => buildResponsesMeasurementBinding(input(forged))).toThrow("responses_measurement_continuity_mismatch");
    });
  it.each(["scope","target","revision","policy","generation","response","pending"] as const)(
    "compares the complete resolved next.%s, not only the wire body", field => {
      const original = realize(manifest([user,answer,followup]),head());
      const changes = {scope:{...original.next.scope,id:"task:child"},target:{...original.next.target,connection:"another-account"},
        revision:original.next.revision+1,policy:"native_replay",generation:original.next.generation+1,
        response:{...original.next.response!,coverage:original.next.response!.coverage.slice(1)},
        pending:{operationId:"unaccepted",inputDigest:original.manifest.digest}};
      const forged = {...original,next:{...original.next,[field]:changes[field]}} as ResponsesInputRealization;
      expect(() => buildResponsesMeasurementBinding(input(forged))).toThrow("responses_measurement_continuity_mismatch");
    });
  it("rejects an internally consistent omitted prefix without its original continuity", () => {
    const original = realize(manifest([user,answer,followup]),head());
    const forged = {...original,continuity:{...original.continuity,previous:null}};
    expect(() => buildResponsesMeasurementBinding(input(forged))).toThrow("responses_measurement_continuity_mismatch");
    const foreign = {...original,continuity:{...original.continuity,previous:{...original.continuity.previous!,
      scope:{...original.manifest.scope,runId:"child"}}}};
    expect(() => buildResponsesMeasurementBinding(input(foreign))).toThrow("responses_continuation_scope_changed");
  });
  it("rejects mismatched manifest, wire suffix, native settings, predecessor or protocol", () => {
    const original = input();
    expect(() => buildResponsesMeasurementBinding({...original,manifest:manifest([followup])})).toThrow("responses_measurement_manifest_mismatch");
    const changedBody = {...original.realization.prepared.body,input:followup.items};
    const changed = {...original.realization,prepared:{...original.realization.prepared,body:changedBody,digest:digest(changedBody),encoded:JSON.stringify(changedBody)}};
    expect(() => buildResponsesMeasurementBinding(input(changed))).toThrow("responses_measurement_selected_input_mismatch");
    const instructions = {...changedBody,input:user.items,instructions:"undeclared"};
    expect(() => buildResponsesMeasurementBinding(input({...changed,prepared:{...changed.prepared,body:instructions,digest:digest(instructions),encoded:JSON.stringify(instructions)}})))
      .toThrow("responses_measurement_settings_mismatch");
    expect(() => buildResponsesMeasurementBinding(input({...original.realization,predecessor:"resp:unbound"}))).toThrow("responses_measurement_continuity_mismatch");
    const wrong = manifest([user],{protocol:OLLAMA_CHAT});
    expect(() => buildResponsesMeasurementBinding(input({...original.realization,manifest:wrong}))).toThrow("responses_measurement_protocol_mismatch");
  });
  it("does not trust a mutable or merely shallow-frozen body after an earlier successful check", () => {
    const original = input();
    const body = structuredClone(original.realization.prepared.body);
    const realization = Object.freeze({...original.realization,prepared:Object.freeze({...original.realization.prepared,body})});
    const value = input(realization);
    buildResponsesMeasurementBinding(value);
    (body.input as JsonObject[])[0].content = "mutated";
    expect(() => buildResponsesMeasurementBinding(value)).toThrow("responses_measurement_body_changed");
  });
  it.each(["previous","conditions"] as const)("does not cache shallow-frozen continuity with mutable %s", field => {
    const original = realize(manifest([user,answer,followup]),head()), continuity = structuredClone(original.continuity);
    const value = input(Object.freeze({...original,continuity:Object.freeze(continuity)}));
    buildResponsesMeasurementBinding(value);
    if (field === "previous") Object.assign(continuity.previous!,{generation:continuity.previous!.generation+1});
    else Object.assign(continuity.conditions,{authorized:false});
    expect(() => buildResponsesMeasurementBinding(value)).toThrow(field === "previous" ?
      "responses_measurement_continuity_mismatch" : "responses_input_authority_changed");
  });
  it("does not cache a frozen realization with a changing plan accessor", () => {
    const original = realize();
    let reason = original.reason;
    const value = input(Object.freeze({...original,get reason() {return reason;}}));
    buildResponsesMeasurementBinding(value); reason = "forged";
    expect(() => buildResponsesMeasurementBinding(value)).toThrow("responses_measurement_continuity_mismatch");
  });
  it("supports cold restored equal manifests without treating corruption as equivalent", () => {
    const original = input(), measured = count(original);
    const restoredManifest = JSON.parse(JSON.stringify(original.manifest));
    const restored = {...original,manifest:restoredManifest,realization:{...original.realization,manifest:JSON.parse(JSON.stringify(original.manifest))}};
    expect(buildResponsesMeasurementBinding(restored)).toEqual(buildResponsesMeasurementBinding(original));
    const restoredRequest = restoreResponsesInputTokenCount(JSON.parse(JSON.stringify(measured.request)));
    expect(reuseResponsesInputTokenCount(restoredRequest,measured.result,responsesMeasurementApplicabilityFromRealization(restored,current(restored))).reusable).toBe(true);
    restoredManifest.groups[0].items[0].content = "corrupt";
    expect(() => buildResponsesMeasurementBinding(restored)).toThrow("native_manifest_changed");
  });
});

describe("fresh measurement applicability", () => {
  it("renews authority/dependency leases without invalidating a reusable count", () => {
    const value = input(), original = current(value), measured = count(value);
    const renewed = {...original,now:"2026-11-13T02:00:01.000Z",authority:{...original.authority,basis:"renewed-authority",checkedAt:"2026-11-13T02:00:00Z",validUntil:"2026-11-13T02:05:00Z"},
      dependencies:{...original.dependencies,basis:"renewed-hold-check",checkedAt:"2026-11-13T02:00:00Z",validUntil:"2026-11-13T02:05:00Z"}};
    const a = responsesMeasurementApplicabilityFromRealization(value,original), b = responsesMeasurementApplicabilityFromRealization(value,renewed);
    expect(a.binding).toEqual(b.binding);expect(b.authorized).toBe(true);expect(b.dependenciesAvailable).toBe(true);
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,b).reusable).toBe(true);
  });
  it("rechecks revoked, unavailable, expired, future and unknown conditions on every observation", () => {
    const value = input(), state = current(value), measured = count(value);
    const first = responsesMeasurementApplicabilityFromRealization(value,state);
    expect(first.authorized).toBe(true);
    for (const authority of [
      {...state.authority,authorized:false}, {...state.authority,validUntil:state.now},
      {...state.authority,validUntil:null}, {...state.authority,checkedAt:"2026-11-13T01:02:00Z"},
    ]) expect(responsesMeasurementApplicabilityFromRealization(value,{...state,authority}).authorized).toBe(false);
    for (const dependencies of [
      {...state.dependencies,available:false},{...state.dependencies,validUntil:state.now},{...state.dependencies,validUntil:null},
    ]) {
      const checked = responsesMeasurementApplicabilityFromRealization(value,{...state,dependencies});
      expect(checked.dependenciesAvailable).toBe(false);
      expect(reuseResponsesInputTokenCount(measured.request,measured.result,checked).reasons).toContain("dependency_unavailable");
    }
    expect(() => responsesMeasurementApplicabilityFromRealization(value,{...state,authority:{...state.authority,validUntil:state.authority.checkedAt}}))
      .toThrow("responses_measurement_validity_invalid");
  });
  it("keeps unknown/mutable resolution and unknown target validity explicit", () => {
    const original = input();
    const value = {...original,targetValidity:null,dependencies:{revision:"url:1",resolution:{kind:"mutable" as const,reason:"unversioned external URL"}}};
    const measured = count(value), state = responsesMeasurementApplicabilityFromRealization(value,current(value));
    expect(measured.request.coverage).toBe("partial");
    expect(reuseResponsesInputTokenCount(measured.request,measured.result,state).reasons).toEqual(expect.arrayContaining(["target_validity_unknown","dependency_resolution_unstable"]));
  });
  it("WA05 caches immutable input work but not current authorization", () => {
    const large = group("large",[{role:"user",content:"prefix ".repeat(20000)}]), value = input(realize(manifest([large])));
    const measured = count(value), state = current(value), serialize = vi.spyOn(JSON,"stringify");
    for (let i=0;i<50;i++) {
      const checked = responsesMeasurementApplicabilityFromRealization(value,{...state,authority:{...state.authority,authorized:i%2===0}});
      expect(reuseResponsesInputTokenCount(measured.request,measured.result,checked).reusable).toBe(i%2===0);
    }
    expect(serialize.mock.results.every(result => typeof result.value !== "string" || result.value.length < 5000)).toBe(true);
  });
});
