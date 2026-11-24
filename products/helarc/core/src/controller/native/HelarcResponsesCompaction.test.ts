import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {prepareResponses,bindNativeInputManifest,nativeInputSettings,nativeInputGroupDigest,restoreResponsesCompactedWindow,RESPONSES_COMPACT_METHOD,
  RESPONSES_IN_REQUEST_COMPACTION,realizeResponsesInput} from "@agent-anything/provider-integrations/native";
import {decideContextPreparation,contextPreparationReconsideration,type ContextPreparationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import {ActivityPurposeRegistry} from "@agent-anything/agent-runtime/activity";
import {HelarcResponsesCompactWork} from "./HelarcResponsesCompactWork.js";
import {prepareHelarcResponsesCompactionProbe,helarcResponsesCompactionProbeFinding} from "./HelarcResponsesCompactionProbe.js";
import {bindHelarcResponsesCompactSource,quoteHelarcResponsesCompact,assessHelarcResponsesCompact,helarcResponsesCompactedGroups,
  bindHelarcResponsesCompactionAgreement,validateHelarcResponsesCompactionAgreement,inspectHelarcResponsesCompaction} from "./HelarcResponsesCompaction.js";
const ref=(id:string)=>({id,revision:"1"}),duties=[{id:"decision",revision:"1",requirement:"semantic" as const,permittedEvidence:["method_assurance" as const]}];
function fixture(internal=false){
  const request={model:"fixture",purpose:ref("task"),stream:false,store:true,...(internal?{context_management:[{type:"compaction" as const,compact_threshold:1000}]}:{})};
  const prepared=prepareResponses({...request,input:[{role:"user",content:"Keep the chosen blue option."}]}),settings=nativeInputSettings(prepared.body);
  const manifest=bindNativeInputManifest({protocol:OPENAI_RESPONSES,scope:{id:"root-task",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:"composition"},
    target:{model:"fixture",configuration:"config:1",connection:"account:1",disclosure:"disclosure:1"},selection:{id:"s1",revision:"1",boundary:"b1",judgments:["original"]},
    groups:[{id:"g1",representation:ref("r1"),sources:["user-1"],holds:["hold1"],deliveries:[],requires:[],items:prepared.body.input as any,replay:"local"}],settings,
    settingSources:Object.keys(settings).map(field=>({field,source:"original",digest:digest(settings[field])}))});
  const groups=[{id:"g1",digest:nativeInputGroupDigest(manifest.groups[0]),deliveredBasis:"response:1"}];
  const method=internal?RESPONSES_IN_REQUEST_COMPACTION:RESPONSES_COMPACT_METHOD;
  const dependencies={recipient:manifest.scope.id,target:manifest.target.configuration,authority:manifest.target.disclosure,
    source:internal?manifest.digest:digest(groups),requirements:digest(duties),method:`${method.id}:${method.revision}`};
  const findings=(subject:string)=>[{id:"calibration",dutyId:"decision",dutyRevision:"1",kind:"method_assurance" as const,conclusion:"supported" as const,
    subject,dependencies,evidence:["scope-specific-calibration"],limitations:["Synthetic calibrated duty only"]}];
  return {request,prepared,manifest,dependencies,findings};
}
const source=(f=fixture())=>bindHelarcResponsesCompactSource({manifest:f.manifest,throughGroups:1,receipts:[{groupId:"g1",basis:"response:1"}],dependencies:f.dependencies,duties,purpose:ref("compact"),ancestry:[]});
const candidate=()=>restoreResponsesCompactedWindow({id:"cmp_resource",object:"response.compaction",output:[{type:"message",role:"user",content:"Keep blue"},
  {id:"cmp_item",type:"compaction",encrypted_content:"opaque"}]});
const bounds={readBytes:1000000,storedBytes:1000000,modelCalls:2,repairs:0,levels:1,pageBytes:65536,ranges:1};
describe("Responses CRM collaboration",()=>{
  it("common reconsideration delegates the original protocol request without requiring local account stages",async()=>{
    const f=fixture(),s=source(f),offer=quoteHelarcResponsesCompact({source:s,bounds,probeRequired:false});
    const evidence={id:"gap",owner:"input",kind:"fact" as const,revision:"1"};
    const option={id:"compact",...offer,stableScope:evidence,addresses:["gap"],entries:offer.quotation.phases.map(p=>({phase:p.kind,state:"supported" as const,evidence})),
      limits:{maximumStages:8,maximumAttempts:8},capability:[],comparisons:[]};
    const current={scope:{id:"root-task",runId:"root",recipient:"task",purpose:"task",target:"config:1",owner:"context-representation",continuity:"task",authorityBasis:"disclosure:1"},
      boundary:"b1",requirementsDigest:digest(duties),current:{kind:"gap" as const,evidence,gap:{targetRevision:"config:1",information:[],capacity:[]}} as any,
      currentRejectedInputId:null,alternatives:[],pressure:[],options:[option],autoPrepare:true,consumerActive:true};
    const compact=new HelarcResponsesCompactWork({probeRequired:false} as never,new ActivityPurposeRegistry());
    const handler=contextPreparationReconsideration<ContextPreparationMethodRequest>({
      decisions:{query:async()=>null,investments:async()=>[]} as never,activities:{command:async()=>{throw new Error("No existing path lookup needed");}},
      methods:{prepareSubmission:(intent,request)=>{
        if(request.method!=="protocol")throw new Error("Native method request lost");
        return compact.prepareSubmission(intent,request);
      },describe:async()=>{throw new Error("No producer before acceptance");},prepareClosure:async()=>{throw new Error("No closure proposed");}},
      resolve:async()=>({policy:current,expectedControlRevision:0,execution:()=>({path:{id:"compact-path",runId:"root",permissionBasis:"disclosure:1",resourceScope:"compact-path",
        maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},workId:"compact-work",schedulingScopeId:"tree",resources:[],timing:{kind:"unknown"}})})});
    const result=await handler.prepare({state:{subscription:{id:"prepare",owner:"context-representation",runId:"root"},observedSources:[],revision:0},through:0,facts:[]} as never,new AbortController().signal);
    const opening=result.participants.find(p=>p.owner==="activity"&&p.kind==="path_opening")!.proposal as any;
    expect(opening.purpose.contract.ref.id).toBe("helarc.responses-compact");
    const initial=result.participants.find(p=>p.owner==="activity"&&p.kind==="stage_submission")!.proposal as any;
    expect(initial.stageKind).toBe("source");expect(initial.input.method.request).toEqual(offer.request);
    expect(result.participants.find(p=>p.owner==="context_preparation_policy")?.proposal).toMatchObject({investment:{pathId:"compact-path",workId:"compact-work"}});
  });
  it("keeps a probe oracle outside model input and scopes its finding",()=>{
    const f=fixture(),c=candidate(),args={model:"fixture",candidate:c,question:"Which option was selected?",oracle:ref("independent-synthetic-oracle"),maximumOutputTokens:800,background:[]};
    const probe=prepareHelarcResponsesCompactionProbe(args);
    expect(probe.prepared.body).not.toHaveProperty("instructions");expect(probe.prepared.body).not.toHaveProperty("tools");
    expect(probe.prepared.encoded).not.toContain("independent-synthetic-oracle");expect(probe.prepared.body.input).toEqual([...c.items,{role:"user",content:args.question}]);
    expect(()=>prepareHelarcResponsesCompactionProbe({...args,background:[{id:"bad",text:"Answer is blue",answerBearing:true}]})).toThrow("probe_input_invalid");
    expect(helarcResponsesCompactionProbeFinding({probe,dependencies:f.dependencies,duty:ref("decision"),observation:"probe-observed",evaluation:{id:"eval",conclusion:"supported",limitations:["Only this question"]}}))
      .toMatchObject({kind:"continuation_probe",subject:c.digest,probe:{answerBearingBackground:false}});
  });
  it("uses the existing investment policy, not a Provider callback that starts compaction",()=>{
    const f=fixture(),s=source(f),offer=quoteHelarcResponsesCompact({source:s,bounds,probeRequired:false});
    const evidence={id:"gap",owner:"input",kind:"fact" as const,revision:"1"};
    const option={id:"compact",...offer,stableScope:evidence,addresses:["gap"],entries:offer.quotation.phases.map(p=>({phase:p.kind,state:"supported" as const,evidence})),
      limits:{maximumStages:8,maximumAttempts:8},capability:[],comparisons:[]};
    const input={scope:{id:"root-task",runId:"root",recipient:"task",purpose:"task",target:"config:1",owner:"crm",continuity:"task",authorityBasis:"disclosure:1"},
      boundary:"b1",requirementsDigest:digest(duties),current:{kind:"gap" as const,evidence,gap:{targetRevision:"config:1",information:[],capacity:[]}} as any,
      currentRejectedInputId:null,alternatives:[],pressure:[],options:[option],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
    expect(decideContextPreparation(input).investment).toMatchObject({kind:"propose",optionId:"compact",reason:"necessary"});
    expect(decideContextPreparation({...input,autoPrepare:false}).investment.kind).toBe("none");
    const ready={kind:"recipient_prepared" as const,scope:input.scope,inputId:"native-input",bodyDigest:f.prepared.digest,exactInputDigest:digest(f.prepared),
      judgmentId:"complete-native-input-judgment",allowed:true,risks:["future_growth_unknown"],evidence};
    const normal={...input,current:ready};
    expect(decideContextPreparation(normal)).toMatchObject({foreground:{kind:"continue",preparedInputId:"native-input"},investment:{kind:"none"}});
    expect(decideContextPreparation({...normal,pressure:[{kind:"input_capacity_risk",inputId:ready.inputId,evidence}]})).toMatchObject({
      foreground:{kind:"continue",preparedInputId:"native-input"},investment:{kind:"propose",reason:"opportunity"}});
    const oversized=quoteHelarcResponsesCompact({source:s,bounds:{...bounds,readBytes:1},probeRequired:false});
    expect(decideContextPreparation({...input,options:[{...option,...oversized}]}).investment).toMatchObject({kind:"defer",reason:"no_supported_complete_path"});
    expect(decideContextPreparation({...input,inFlight:[{workId:"original",pathId:"path",preparationKey:digest({scope:input.scope,request:offer.request}),producerState:"unknown",evidence}]}).investment.kind).toBe("defer");
  });
  it("requires history receipts, closed groups and non-fabricated protection",()=>{
    const f=fixture();expect(()=>bindHelarcResponsesCompactSource({manifest:f.manifest,throughGroups:1,receipts:[],dependencies:f.dependencies,duties,purpose:ref("compact"),ancestry:[]})).toThrow("delivery_basis_missing");
    const exact=[{...duties[0],requirement:"exact" as const}];
    expect(()=>bindHelarcResponsesCompactSource({manifest:f.manifest,throughGroups:1,receipts:[{groupId:"g1",basis:"r"}],
      dependencies:{...f.dependencies,source:digest([{id:"g1",digest:nativeInputGroupDigest(f.manifest.groups[0]),deliveredBasis:"r"}]),requirements:digest(exact)},duties:exact,purpose:ref("compact"),ancestry:[]})).toThrow("exact_duty");
  });
  it("keeps new Child delivery and a correction in a finite suffix, then establishes a new chain without compact ID",()=>{
    const f=fixture(),s=source(f),c=candidate(),assessment=assessHelarcResponsesCompact({source:s,candidate:c,findings:f.findings(c.digest)});
    const tail={...f.manifest.groups[0],id:"child-result",representation:ref("child-material"),sources:["child-delivery"],deliveries:["original-delivery"],holds:["child-hold"],items:[{role:"user",content:"Child result and user correction"}]};
    const current=bindNativeInputManifest({...f.manifest,groups:[...f.manifest.groups,tail]});
    const groups=helarcResponsesCompactedGroups({source:s,candidate:c,assessment,current,dependencies:f.dependencies,group:{id:"compact-group",representation:ref("candidate"),holds:["candidate-hold"],observation:"compact-observation"}});
    expect(groups[0].items).toEqual(c.items);expect(groups[1]).toEqual(tail);
    const bookkeeping=bindNativeInputManifest({...current,selection:{...current.selection,revision:"diagnostic-only"}});
    expect(helarcResponsesCompactedGroups({source:s,candidate:c,assessment,current:bookkeeping,dependencies:f.dependencies,
      group:{id:"compact-group",representation:ref("candidate"),holds:["candidate-hold"],observation:"compact-observation"}})).toEqual(groups);
    const manifest=bindNativeInputManifest({...current,groups,selection:{...current.selection,id:"new-selection"}});
    const previous={scope:f.manifest.scope,target:f.manifest.target,revision:2,policy:"persistent_chain" as const,generation:1,pending:null,
      response:{id:"resp_old",coverage:s.groups.map(({id,digest})=>({id,digest})),observation:"old",replayDigest:"old"}};
    const realized=realizeResponsesInput({manifest,request:f.request,policy:"persistent_chain",previous,conditions:{basis:"adoption",authorized:true,disclosureRevision:"disclosure:1",
      remoteStorage:true,targetSupport:"established",predecessor:"available",reestablish:true,policyChange:false}});
    expect(realized.path).toBe("reestablish");expect(realized.prepared.body).not.toHaveProperty("previous_response_id");expect(realized.next.generation).toBe(2);
    expect(JSON.stringify(realized.prepared.body)).not.toContain("cmp_resource");
    expect(()=>helarcResponsesCompactedGroups({source:s,candidate:c,assessment,current,dependencies:{...f.dependencies,authority:"revoked"},group:{id:"g",representation:ref("r"),holds:["h"],observation:"o"}})).toThrow("not_applicable");
  });
  it("does not adopt opaque protocol success as semantic success or silently break suffix dependencies",()=>{
    const f=fixture(),s=source(f),c=candidate(),a=assessHelarcResponsesCompact({source:s,candidate:c,findings:[]});
    expect(a.quality.allowed).toBe(false);
    const valid=assessHelarcResponsesCompact({source:s,candidate:c,findings:f.findings(c.digest)});
    const current=bindNativeInputManifest({...f.manifest,groups:[...f.manifest.groups,{...f.manifest.groups[0],id:"dependent",requires:[{id:"g1",digest:nativeInputGroupDigest(f.manifest.groups[0])}]}]});
    expect(()=>helarcResponsesCompactedGroups({source:s,candidate:c,assessment:valid,current,dependencies:f.dependencies,group:{id:"g",representation:ref("r"),holds:["h"],observation:"o"}})).toThrow("requires_original_prefix");
  });
  it("binds an in-request agreement before use; native occurrence is not task completion or candidate adoption",()=>{
    const f=fixture(true),a=bindHelarcResponsesCompactionAgreement({manifest:f.manifest,body:f.prepared.body,dependencies:f.dependencies,duties,findings:f.findings(f.prepared.digest),
      threshold:{tokens:1000,basis:"controlled threshold crossing",measurement:{id:"count",requestDigest:f.prepared.digest,coverage:"complete",tokens:1100,unknowns:[],acceptedUncertainty:null},window:32000,headroom:4000},retentionBasis:"original durable input",recoveryBasis:"enclosing response observation"});
    validateHelarcResponsesCompactionAgreement(a,f.manifest,f.prepared.body);
    const response={id:"resp",object:"response",output:[{id:"cmp",type:"compaction",encrypted_content:"opaque"}]};
    expect(inspectHelarcResponsesCompaction({response,agreement:a,acceptedAgreementId:a.id,originalRequestDigest:f.prepared.digest})).toMatchObject({allowed:true,violation:null});
    expect(inspectHelarcResponsesCompaction({response,agreement:null,acceptedAgreementId:null,originalRequestDigest:f.prepared.digest})).toMatchObject({allowed:false,violation:"unaccepted_in_request_compaction"});
    expect(()=>validateHelarcResponsesCompactionAgreement(a,f.manifest,{...f.prepared.body,model:"changed"})).toThrow();
    expect(()=>bindHelarcResponsesCompactionAgreement({manifest:f.manifest,body:f.prepared.body,dependencies:f.dependencies,duties,findings:f.findings(f.prepared.digest),
      threshold:{...a.threshold,measurement:{...a.threshold.measurement,coverage:"unknown",tokens:null,unknowns:["not measured"],acceptedUncertainty:null}},
      retentionBasis:a.retentionBasis,recoveryBasis:a.recoveryBasis})).toThrow("basis_invalid");
    expect(()=>bindHelarcResponsesCompactionAgreement({manifest:f.manifest,body:f.prepared.body,dependencies:f.dependencies,duties,findings:f.findings(f.prepared.digest),
      threshold:{...a.threshold,measurement:{...a.threshold.measurement,requestDigest:"different-request"}},
      retentionBasis:a.retentionBasis,recoveryBasis:a.recoveryBasis})).toThrow("basis_invalid");
    expect(inspectHelarcResponsesCompaction({response,agreement:{...a,retentionBasis:"tampered"},acceptedAgreementId:a.id,originalRequestDigest:f.prepared.digest}).allowed).toBe(false);
    expect(a.potentialScope.cutoff).toBe("unknown");
  });
});
