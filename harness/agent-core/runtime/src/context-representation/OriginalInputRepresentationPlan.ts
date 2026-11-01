import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialAccessDescription,MaterialCustodyPort} from "@agent-anything/context/custody";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityPathIntent} from "../activity/ActivityHandoff.js";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {RepresentationMethodProgress,RepresentationMethodRequest} from "./methods/RepresentationMethod.js";
import type {ContextInputPreparationRequest} from "./ContextInputPreparation.js";
import type {ContextMethodInputPlan} from "./ContextMethodInputSupply.js";
import {validateMethodInputScheduling} from "./ContextMethodInputScheduling.js";
import {originalInputRepresentationDemand,validateOriginalInputRepresentationMembers,type OriginalInputRepresentationMember} from "./OriginalInputRepresentationDemand.js";
export type {OriginalInputRepresentationSupply} from "./OriginalInputRepresentationDemand.js";

/** Builds the recipient's durable continuation from confirmed work, not a second method execution. */
export async function originalInputRepresentationPlan(input:{readonly sources:OriginalInputSources;
  readonly members:readonly (OriginalInputRepresentationMember & {readonly progress:RepresentationMethodProgress})[];
  readonly inputSupply?:import("./InputSupplyResponsibility.js").InputSupplyBinding;
  readonly scheduling?:Omit<import("../activity/index.js").ActivitySchedulingIntent,"allowedPathIds">;
  readonly scope:ContextUseScope;readonly preparation:ContextInputPreparationRequest;
  readonly intent:Omit<ActivityPathIntent,"purpose"|"owner">;
  readonly checkTemplate:RepresentationMethodRequest["template"];
  readonly checkCapacity:RepresentationMethodRequest["capacity"];readonly checkBounds:RepresentationMethodRequest["bounds"];
  readonly materials:MaterialCustodyPort;readonly signal:AbortSignal}):Promise<ContextMethodInputPlan> {
  const {scope,intent,signal}=input;signal.throwIfAborted();
  validateOriginalInputRepresentationMembers(input.sources,input.members);
  if(intent.runId!==scope.runId||intent.permissionBasis!==scope.authorityBasis||input.members.some(m=>m.pathId===intent.id)||
    input.preparation.demand.runId!==scope.runId||input.preparation.demand.targetRevision!==scope.target)
    throw new TypeError("original_representation_plan_binding_invalid");
  const members=[...input.members].sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0);
  const admissions:NonNullable<ContextMethodInputPlan["materialAdmissions"]>[number][]=[],resolved:Parameters<typeof originalInputRepresentationDemand>[0]["members"][number][]=[],representations=new Set<string>();
  for(const member of members) {
  const {progress}=member;
  if(progress.state!=="ready"||progress.resultIds.length!==1)throw new TypeError("original_representation_plan_binding_invalid");
  const candidate=progress.candidates.find(c=>c.id===progress.resultIds[0]);
  if(!candidate)throw new TypeError("original_representation_candidate_unconfirmed");
  const representation=modelInputValueDigest(candidate.representation);
  if(representations.has(representation))throw new TypeError("original_representation_duplicate_candidate");
  representations.add(representation);
  const description=await input.materials.command({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient}) as MaterialAccessDescription|null;
  signal.throwIfAborted();if(!description)throw new TypeError("original_representation_candidate_unavailable");
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  const identity=modelInputValueDigest({consumer:intent.id,producer:member.pathId,representation,source:candidate.access,recipient,authority:scope.authorityBasis});
  const hold={id:`${intent.id}:candidate:${identity}`,instanceId:description.hold.instanceId,consumer:recipient,
    responsibility:"preparation" as const,range:candidate.access.range,basis:intent.id,releaseCondition:"Explicit recipient consumer settlement"};
  const access={...candidate.access,id:`${hold.id}:access`,holdId:hold.id,recipient};
  admissions.push({source:candidate.access,hold,grant:{id:`${hold.id}:grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:scope.authorityBasis}});
  resolved.push({...member,access});
  }
  const demand=originalInputRepresentationDemand({id:`${intent.id}:demand`,sources:input.sources,original:input.preparation.demand,members:resolved});
  const {demand:_original,...preparation}=input.preparation;
  const resourceLimits={readBytes:input.checkBounds.readBytes,storedBytes:input.checkBounds.storedBytes,
    modelCalls:input.checkBounds.modelCalls,measurementCalls:input.checkCapacity.maximumMeasurements};
  if(intent.resourceLimits&&modelInputValueDigest(intent.resourceLimits)!==modelInputValueDigest(resourceLimits))
    throw new TypeError("original_representation_plan_resource_binding_invalid");
  const sharedIntent={...intent,resourceLimits};
  const pageBytes=input.checkBounds.pageBytes,maximumStages=1+admissions.reduce((total,a)=>total+Math.ceil((a.source.range.end-a.source.range.start)/pageBytes),0);
  const readBytes=admissions.reduce((total,a)=>total+a.source.range.end-a.source.range.start,0);
  if(readBytes>input.checkBounds.readBytes||readBytes>demand.maximumReadBytes)throw new TypeError("input_materialization_read_budget_exceeded");
  if(!Number.isSafeInteger(pageBytes)||pageBytes<1||maximumStages>intent.maximumStages||maximumStages>intent.maximumAttempts)
    throw new TypeError("input_materialization_known_work_exceeds_delegation");
  const plan:ContextMethodInputPlan={revision:"5",scheduling:input.scheduling?{...input.scheduling,allowedPathIds:[intent.id,`${intent.id}:organization`,`${intent.id}:combination`]}:null,
    ...(input.inputSupply?{inputSupply:input.inputSupply}:{}),producers:members.map(m=>({pathId:m.pathId,candidateIds:m.progress.resultIds})),scope,
    materialAdmissions:admissions,
    materialization:{intent:sharedIntent,request:{kind:"context_input_materialization",demand,preparation,
      preparationIntent:{...sharedIntent,id:`${intent.id}:organization`},pageBytes}},
    check:{intent:{...sharedIntent,id:`${intent.id}:combination`},sourceBasis:"qualified_when_covered",objective:"Check the entire proposed recipient input against the supplied evidence, including retained content, exact call/result relations, instructions, objectives and new deliveries. Where an original preservation judgment is explicitly inherited, assess the qualified representation's use in this new combination, not its fidelity to unseen originals. A derived result body must agree with the unchanged original envelope and siblings. A historical account must not become new user authority. Neither form may erase failures, uncertainty or pending obligations.",
      template:input.checkTemplate,capacity:input.checkCapacity,bounds:input.checkBounds}};
  validateMethodInputScheduling(plan);return plan;
}
