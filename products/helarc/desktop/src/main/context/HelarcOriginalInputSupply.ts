import {modelInputValueDigest,organizeOriginalInput} from "@agent-anything/model-interaction/input";
import type {Provider} from "@agent-anything/model-interaction";
import type {MaterialRecipient} from "@agent-anything/context/custody";
import {OriginalInputSupply,type OriginalInputSource,planOriginalInputPublications,supplyOriginalInputMethod,originalInputAccountScopes,supplyOriginalInputAccountMethod,originalInputResultTextScopes,supplyOriginalInputResultTextMethod,resupplyOriginalInputMethod,
  type ContextPreparationOption,
  originalInputDataTextScopes,supplyOriginalInputDataTextMethod,recipientContextDeliveryId,
  type OriginalInputAccountScopes,type OriginalInputSupplyBasis,type OriginalInputSupplyBinding,
  type SourceMaterialPublicationWork,type ContextInputPreparationWork,type OriginalInputSources,
  type OriginalInputPublicationPlan} from "@agent-anything/agent-runtime/context-representation";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityHandoffPort} from "@agent-anything/agent-runtime/activity";
import {readModelInputRejections,type RejectedModelInput} from "@agent-anything/agent-runtime/model-access";
import {validateHelarcContextRunBinding,type HelarcContextRunBinding} from "./HelarcContextRunBinding.js";
import {runActivityLifetime} from "../execution-storage/RunActivityLifetime.js";

export interface HelarcOriginalInputBinding extends OriginalInputSupplyBinding {
  readonly rejectedInputs:readonly RejectedModelInput[];
  readonly sources:OriginalInputSources;
  readonly observation:{readonly sequence:number;readonly representationContinuity:string}|null;
  readonly scope:ContextUseScope;
  readonly publications:readonly OriginalInputPublicationPlan[];
  readonly accountScopes:OriginalInputAccountScopes;
  readonly resultTextScopes:ReturnType<typeof originalInputResultTextScopes>;
  readonly dataTextScopes:ReturnType<typeof originalInputDataTextScopes>;
}

/** Source eligibility is not investment: the common preparation policy consumes these offers. */
export function supplyHelarcOriginalInputRepresentationMethods(binding:HelarcOriginalInputBinding,input:{
  readonly policy:HelarcContextRunBinding["policy"];readonly addresses:readonly string[];
}) {
  const shared=methodSupplyInput(binding,input);
  const supplied=[...binding.resultTextScopes.scopes.map(scope=>supplyOriginalInputResultTextMethod({...shared,scope})),
    ...binding.dataTextScopes.scopes.map(scope=>supplyOriginalInputDataTextMethod({...shared,scope})),
    ...binding.accountScopes.scopes.map(scope=>supplyOriginalInputAccountMethod({...shared,scope}))];
  const offers=supplied.slice(0,input.policy.maximumOptions);
  const eligible=binding.resultTextScopes.enumeration.eligible+binding.dataTextScopes.enumeration.eligible+binding.accountScopes.enumeration.eligible;
  const report:import("@agent-anything/agent-runtime/context-representation").ContextMethodSupplyReport={owner:"helarc-original-input",revision:"1",
    sourceBoundary:binding.sources.boundary,enumeration:{complete:eligible===offers.length,eligible,returned:offers.length},
    unavailable:[...binding.accountScopes.exclusions,...binding.resultTextScopes.exclusions,...binding.dataTextScopes.exclusions],
    offers:offers.map(offer=>({optionId:offer.option.id,scopeId:offer.scope.id,requirementIds:offer.request.requirements.map(r=>r.id),
      sources:offer.scope.groups.map(g=>({role:g.role,materialId:g.id,version:g.revision}))}))};
  return {offers,report};
}

export function resupplyHelarcOriginalInputRepresentationMethod(binding:HelarcOriginalInputBinding,
  input:Parameters<typeof supplyHelarcOriginalInputRepresentationMethods>[1],original:ContextPreparationOption) {
  return resupplyOriginalInputMethod(methodSupplyInput(binding,input),original);
}

function methodSupplyInput(binding:HelarcOriginalInputBinding,input:Parameters<typeof supplyHelarcOriginalInputRepresentationMethods>[1]) {
  return {sources:binding.sources,publications:binding.publications,
    sourceRecipient:{runId:binding.scope.runId,recipient:binding.scope.recipient,purpose:binding.scope.purpose},
    target:binding.scope.target,authorizationBasis:binding.scope.authorityBasis,addresses:input.addresses,
    capacity:{limits:binding.input.limits,reservations:binding.input.reservations,policy:binding.input.policy,
      maximumCombinations:input.policy.input.maximumCombinations,maximumMeasurements:input.policy.input.maximumExternalMeasurements},
    bounds:input.policy.method.bounds,limits:{maximumStages:input.policy.method.maximumStages,maximumAttempts:input.policy.method.maximumAttempts}};
}

/** The task's admitted Host authority supplies method access; it is not borrowed Agent identity. */
export function supplyHelarcOriginalInputMethodInput(binding:Pick<HelarcOriginalInputBinding,"sources"|"scope"|"publications">,
  input:Pick<Parameters<typeof supplyOriginalInputMethod>[0],"consumerId"|"specification"|"groups">) {
  return supplyOriginalInputMethod({...input,sources:binding.sources,publications:binding.publications,
    sourceRecipient:{runId:binding.scope.runId,recipient:binding.scope.recipient,purpose:binding.scope.purpose},
    target:binding.scope.target,authorizationBasis:binding.scope.authorityBasis});
}
type SupplyPorts<TSource extends OriginalInputSource>=ConstructorParameters<typeof OriginalInputSupply<TSource>>[0];
export interface HelarcOriginalInputSupplyPorts<TSource extends OriginalInputSource> {
  readonly source:SupplyPorts<TSource>["source"];
  readonly describe:(basis:OriginalInputSupplyBasis<TSource>)=>{readonly sources:OriginalInputSources;readonly recipient:MaterialRecipient;readonly observation:HelarcOriginalInputBinding["observation"]};
  readonly provider:Provider;
  readonly activities:ActivityHandoffPort;
  readonly responsibilities:SupplyPorts<TSource>["responsibilities"];
  readonly publications:Pick<SourceMaterialPublicationWork,"prepareSubmission">;
  readonly preparation:Pick<ContextInputPreparationWork,"prepareSubmission">;
  /** Resolves the admitted tree binding, never live Settings. */
  readonly binding:(basis:OriginalInputSupplyBasis<TSource>)=>Promise<{
    readonly context:HelarcContextRunBinding;
    readonly treeScopeId:string;
    readonly modelPoolId:string;
    readonly localPoolId:string;
    readonly deliveryMode:"buffered"|"streaming";
  }>;
  readonly authorize:SupplyPorts<TSource>["authorize"];
  readonly decide:(basis:OriginalInputSupplyBasis<TSource>,binding:HelarcOriginalInputBinding,
    result:Parameters<SupplyPorts<TSource>["decide"]>[2],snapshot:Parameters<SupplyPorts<TSource>["decide"]>[3],signal:AbortSignal)=>ReturnType<SupplyPorts<TSource>["decide"]>;
  readonly receivers?:SupplyPorts<TSource>["receivers"];
}

/** Product source rules and Host bindings; representation decisions remain with the supplied CRM. */
export function createHelarcOriginalInputSupply<TSource extends OriginalInputSource>(ports:HelarcOriginalInputSupplyPorts<TSource>):OriginalInputSupply<TSource> {
  return new OriginalInputSupply<TSource>({source:ports.source,activities:ports.activities,responsibilities:ports.responsibilities,publications:ports.publications,preparation:ports.preparation,
    authorize:ports.authorize,...(ports.receivers?{receivers:ports.receivers}:{}),
    resolve:async(basis,signal)=>{
      const bound=await ports.binding(basis);signal.throwIfAborted();validateHelarcContextRunBinding(bound.context);
      const {policy}=bound.context,consumer=basis.consumer.intent,source=basis.source;
      if(!ports.provider.encodeInput||!basis.sourceStage.result||!bound.treeScopeId||!bound.modelPoolId||!bound.localPoolId||
        source.request.composition.providerId!==ports.provider.descriptor.id||source.request.composition.model!==ports.provider.modelContext.target.model)
        throw new TypeError("helarc_task_input_binding_unavailable");
      const {sources,recipient,observation}=ports.describe(basis);
      const rejectedInputs=await readModelInputRejections(ports.activities,basis.consumer,basis.need,basis.sourceStage.request.id);
      if(sources.runId!==consumer.runId||recipient.runId!==consumer.runId||recipient.purpose!==source.request.purpose||
        modelInputValueDigest(sources.request)!==modelInputValueDigest(source.request))throw new TypeError("helarc_original_input_description_changed");
      const target=ports.provider.encodeInput(source.request,bound.deliveryMode).targetDigest;
      const scope:ContextUseScope={...recipient,id:`${consumer.runId}:purpose-input:${modelInputValueDigest({target,context:bound.context.id,recipient,authority:consumer.permissionBasis})}`,
        owner:"context-representation",continuity:recipient.purpose,target,authorityBasis:consumer.permissionBasis};
      const workId=`${basis.need.id}:supply`,preparationId=`${workId}:prepare`;
      const publications=await planOriginalInputPublications({sources,recipient,target,activities:ports.activities,signal,
        observedAt:basis.sourceStage.result.recordedAt,maximumSourceBytes:policy.method.bounds.readBytes,deliveryLifetime:runActivityLifetime(consumer.runId)});
      const maximumStages=policy.input.maximumCombinations+policy.input.maximumExternalMeasurements+1;
      const demand=organizeOriginalInput({composition:sources.request.composition,demand:{id:`${workId}:demand`,...recipient,
        targetRevision:target,historyBoundary:sources.boundary,deliveryIds:sources.groups.flatMap(group=>group.deliveries.map(delivery=>recipientContextDeliveryId(delivery.id,recipient))),
        dependencies:{source:sources.id,contextBinding:bound.context.id},maximumCombinations:policy.input.maximumCombinations,
        maximumExternalMeasurements:policy.input.maximumExternalMeasurements,maximumReadBytes:policy.method.bounds.readBytes},
        groups:sources.groups.map(group=>({id:group.id,owner:group.owner,revision:group.revision,sectionIds:group.occurrences.map(o=>o.section.id),duties:group.duties,
          deliveryIds:group.deliveries.map(d=>recipientContextDeliveryId(d.id,recipient))}))});
      const accountScopes=originalInputAccountScopes({sources,maximum:policy.maximumOptions,
        backgroundGroupIds:sources.groups.filter(g=>g.duties.some(d=>["objective","behavior","new_information"].includes(d))).map(g=>g.id)});
      const resultTextScopes=originalInputResultTextScopes({sources,maximum:policy.maximumOptions,
        backgroundGroupIds:sources.groups.filter(g=>g.duties.some(d=>["objective","behavior","new_information"].includes(d))).map(g=>g.id)});
      const dataTextScopes=originalInputDataTextScopes({sources,maximum:policy.maximumOptions,
        backgroundGroupIds:sources.groups.filter(g=>g.duties.some(d=>["objective","behavior","new_information"].includes(d))).map(g=>g.id)});
      const binding:HelarcOriginalInputBinding={sources,scope,observation,publications,accountScopes,resultTextScopes,dataTextScopes,rejectedInputs,configuration:{id:bound.context.id,revision:bound.context.revision},
        schedule:{id:`${workId}:schedule`,workId,runId:consumer.runId,scopeId:bound.treeScopeId,owner:"context-representation",reason:"necessary",
          decisionId:basis.need.id,policyRevision:`${policy.id}@${policy.revision}`,delayImpact:"The original purpose input needs source retention and organization",
          timing:{kind:"unknown"},resources:[{capability:"material-write",poolId:bound.localPoolId,units:1},
            {capability:"model-measurement",poolId:bound.modelPoolId,units:1}],delegatedPathOwners:["material-source"]},
        preparation:{id:preparationId,runId:consumer.runId,permissionBasis:consumer.permissionBasis,resourceScope:preparationId,scheduledWorkId:workId,
          maximumStages,maximumAttempts:maximumStages*policy.maximumTransportAttempts,maximumConcurrent:1,deadlineAt:consumer.deadlineAt},
        input:{kind:"context_input_preparation",demand,template:sources.request,limits:[],reservations:[],
          policy:{id:"helarc-task-input",revision:"1",purpose:recipient.purpose,basis:"Complete Provider encoding and available measurements; uncertainty remains explicit",
            allowEstimatedFit:true,allowUnknown:true},allowExternalMeasurement:true,deliveryMode:bound.deliveryMode,localMeasurements:[],sharedCapacity:null,
          materialAccesses:publications.flatMap(p=>p.published?[p.published.access]:[])}};
      return binding;
    },
    decide:(basis,binding,result,snapshot,signal)=>ports.decide(basis,binding as HelarcOriginalInputBinding,result,snapshot,signal)});
}
