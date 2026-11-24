import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {helarcObservationPathId} from "./HelarcAcceptedObservation.js";
import {OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT,requireModelPurpose,snapshotModelAgentCompositionBinding,type ModelAgentCompositionBinding} from "@agent-anything/model-interaction/protocol";
import type {ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import {SourceMaterialPublicationWork} from "@agent-anything/agent-runtime/context-representation";
import {createHelarcResponsesTaskExecution,createHelarcDeepSeekTaskExecution,createHelarcOllamaTaskExecution,
  createHelarcResponsesStructuredPurposes,createHelarcDeepSeekStructuredPurposes,createHelarcOllamaStructuredPurposes,
  type HelarcNativeTaskCompositionPorts,type HelarcNativeTaskExecutionFactory,type HelarcNativeStructuredPurposePorts} from "@agent-anything/helarc/composition";
import {HELARC_CONTROLLER_CAPABILITY,createHelarcNativeNarrativeReader,readHelarcResponsesTaskContinuation,helarcNativeObservationContinuity,
  HELARC_NATIVE_MEASURED_ORIGINAL_INPUT_PURPOSE,HELARC_RESPONSES_COMPACT_PURPOSE,HELARC_RESPONSES_IN_REQUEST_RECEPTION_PURPOSE} from "@agent-anything/helarc/controller";
import {createHelarcNativePresentationReader} from "@agent-anything/helarc/run";
import {providerCompactionTarget,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "../provider/ProviderConfigurationService.js";
import {createHelarcNativeResourceContributions} from "@agent-anything/helarc/controller";
import type {RetainedConnection} from "../provider/ProviderConnectionRetention.js";
import {HelarcResponsesPurposeObserver} from "../provider/HelarcResponsesPurposeObserver.js";
import {HelarcChatPurposeObserver} from "../provider/HelarcChatPurposeObserver.js";
import type {HelarcNativeHostArrangement,HelarcNativeHostActivities} from "../run/HelarcNativeHostArrangement.js";
import {createHelarcRunActivityScope} from "./HelarcRunActivityScope.js";
import {HelarcNativeObservation} from "./HelarcNativeObservation.js";
import {bindHelarcNativeContextMethods} from "./HelarcNativeContextMethods.js";
import {bindHelarcNativeTaskInputs} from "./HelarcNativeTaskInputs.js";
import {helarcWorkCapacityEvidence} from "./HelarcNativeCapacityEvidence.js";
import {readHelarcNativeGenerationPlanning,prepareHelarcNativeStructuredInput} from "@agent-anything/helarc/controller";
import {createHelarcMaterialAccess,helarcMaterialRecipient} from "./HelarcMaterialAccess.js";
import {createHelarcReportMaterialHandoff,reportCaptureAuthorization} from "./HelarcReportMaterialHandoff.js";
import {HelarcNativeReportDelivery} from "./HelarcNativeReportDelivery.js";
import {bindHelarcResponsesCompactMethods} from "./HelarcResponsesCompactMethods.js";
import {createHelarcResponsesInputMeasurement,HELARC_RESPONSES_MEASUREMENT_PARTICIPANT,HELARC_RESPONSES_MEASUREMENT_SELECTION} from "./HelarcResponsesInputMeasurement.js";
import {HelarcNativeAuxiliaryInputPreparation,HELARC_NATIVE_AUXILIARY_INPUT_PURPOSE} from "./HelarcNativeAuxiliaryInputPreparation.js";
import {frozenNativePurposes,NativeActivityPurposeRegistry} from "./HelarcNativeActivityPurposes.js";

export const HELARC_NATIVE_RUN_ACTIVITIES={id:"helarc.native-run-activities",revision:"1",modelPoolCapacity:1,localPoolCapacity:2} as const;

/** Original native participants on the application-owned activity Host, not an alternate Runner. */
export function createHelarcNativeRunArrangement(configuration:ProviderConfiguration,connection:RetainedConnection,
  providers:ProviderConfigurationService):HelarcNativeHostArrangement&{close():Promise<void>;retire():Promise<string|null>} {
  let transport:HelarcResponsesPurposeObserver|HelarcChatPurposeObserver|undefined;
  let participants:HelarcNativeHostActivities|undefined;
  let originalScope:{rootRunId:string;store:unknown;context:string}|undefined;
  let retireScope:(()=>Promise<boolean>)|undefined;
  return {configuration,connection,close:async()=>transport?.close(),retire:async()=>{
    if(!originalScope||!retireScope||!await retireScope())return null;
    await transport?.close();return originalScope.rootRunId;
  },compose(input){
    if(participants){
      if(originalScope?.rootRunId!==input.rootRunId||originalScope.store!==input.store||originalScope.context!==digest(input.context))
        throw new TypeError("native_run_arrangement_scope_changed");
      return participants;
    }
    originalScope={rootRunId:input.rootRunId,store:input.store,context:digest(input.context)};
    const {store,rootRunId,context,now}=input,c=configuration,n=c.native,ref=(id:string)=>({id,revision:"1"});
    const protocol=c.protocol==="openai.responses"?OPENAI_RESPONSES:c.protocol==="ollama.chat"?OLLAMA_CHAT:DEEPSEEK_CHAT_COMPLETIONS;
    const nativeModel={configuration:{id:c.id,revision:c.revision},protocol,model:c.model,connectionBinding:ref(c.connectionBindingId)};
    const scope=createHelarcRunActivityScope({...input,contextId:context.id,composition:HELARC_NATIVE_RUN_ACTIVITIES,
      modelPoolId:`helarc-native-model:${digest(nativeModel)}`});
    const {permissionBasis,scopeId,modelPoolId,localPoolId,original,authorize,host}=scope;
    retireScope=()=>scope.retire();
    const registry=new NativeActivityPurposeRegistry<ActivityPurposeHandler>();
    const purposes=frozenNativePurposes(context.purposes);
    transport=c.protocol==="openai.responses"?new HelarcResponsesPurposeObserver(store,providers):new HelarcChatPurposeObserver(store,providers);
    const carrier=transport,bindings=new Map<string,ModelAgentCompositionBinding>();
    let composed:Awaited<ReturnType<HelarcNativeTaskExecutionFactory>>|null=null;
    let retainedCompositions:{root:ModelAgentCompositionBinding;delegated:ModelAgentCompositionBinding}|null=null;
    function retainBindings(values:readonly ModelAgentCompositionBinding[]){
      for(const candidate of values){
        const value=snapshotModelAgentCompositionBinding(candidate);
        const agent=value.composition.agent,previous=bindings.get(agent.id);
        if(previous&&digest(previous)!==digest(value))throw new TypeError("native_original_agent_composition_changed");
        if(value.composition.protocol.id!==protocol.id||value.composition.configuration.configuration.id!==c.id||
          value.composition.configuration.configuration.revision!==c.revision||value.composition.configuration.model!==c.model||
          value.composition.configuration.connectionBinding.id!==c.connectionBindingId)throw new TypeError("native_original_configuration_changed");
        bindings.set(agent.id,value);
      }
    }
    async function composition(runId:string){
      const member=await original(runId),agent=member.control.agentDefinition;
      const binding=bindings.get(agent.id);
      if(!binding||binding.composition.agent.revision!==agent.revision)throw new TypeError("native_original_agent_composition_unavailable");
      return binding;
    }
    const check=async(activity:import("@agent-anything/agent-runtime/model-access").ProtocolModelActivity,signal:AbortSignal,dispatch=false)=>{
      await scope.authorizeNative(activity.scope.runId,dispatch?"dispatch":"local",signal);
      if(digest(activity.composition)!==digest(await composition(activity.scope.runId))||activity.conditions.authority.id!==permissionBasis)
        throw new TypeError("native_original_activity_authority_changed");
    };
    const observation=new HelarcNativeObservation({store,registry,host,authorize,now,rediscoveryMs:100,settlementWaitMs:5000,
      arrange:async state=>{
        const id=helarcObservationPathId(state.activity.scope.activityId),runId=state.activity.scope.runId;
        return {identity:{id,runId,permissionBasis,resourceScope:id,scheduledWorkId:id,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:await scope.deadline(runId)},
          schedule:{id:`${id}:schedule`,workId:id,runId,scopeId,owner:"model-access",reason:"task",allowedPathIds:[id],decisionId:id,
            policyRevision:HELARC_NATIVE_RUN_ACTIVITIES.revision,delayImpact:"Original native response is required by its recipient",timing:{kind:"unknown"},
            resources:[{poolId:modelPoolId,capability:"model-request",units:1}]}};
      },observe:(state,request,_mode,signal,preview)=>carrier.observe(state,request,signal,()=>check(state.activity,signal,true),preview),
      interrupt:async(state,request)=>{await carrier.interrupt(state,request,`${state.activity.scope.activityId}:cancel`);}});
    const measurement=c.protocol==="openai.responses"?createHelarcResponsesInputMeasurement({store,configuration:c,providers,now,check,workBudget:context.maxInputTokensPerGeneration!==undefined}):undefined;
    const auxiliaryInputs=measurement&&purposes.includes(HELARC_NATIVE_AUXILIARY_INPUT_PURPOSE)?new HelarcNativeAuxiliaryInputPreparation({store,registry,measurement,authorize,host,now,
      arrangement:async runId=>({permissionBasis,scopeId,modelPoolId,deadlineAt:await scope.deadline(runId),
        maximumMeasurements:context.policy.input.maximumExternalMeasurements})}):null;
    const structuredPorts:HelarcNativeStructuredPurposePorts={methodPurpose:ref("context_representation"),inputRevision:"3",selections:store.contextSelections,composition,
      restoreInput:async(source,invocation)=>"event" in source&&auxiliaryInputs?
        auxiliaryInputs.restore(source.activityId,source.source,invocation.signal):null,
      interruptInput:async(source,invocation)=>{
        if("event" in source)await auxiliaryInputs?.interrupt(source.activityId,source.source,invocation.signal);
        else if(source.measurement&&measurement)await measurement.interruptStructured(source,invocation.signal);
      },
      conditions:async source=>({input:source.source,authority:ref(permissionBasis),resources:ref(context.id),control:ref("original-admission")}),
      prepareInput:async(request,source,invocation)=>{
        await check(request.activity,invocation.signal);
        const target=helarcWorkCapacityEvidence(c,now(),context);
        const original="inputCapacity" in source?source.inputCapacity:undefined;
        const capacity=original?.capacity??{limits:target.limits,reservations:[(await readHelarcNativeGenerationPlanning(store.protocolJournal,request.activity)).reservation],
          policy:{id:"helarc.native-auxiliary-capacity",revision:"1",purpose:request.activity.scope.purpose.id,
            basis:`${target.basis}; unknown token measurement is not proof of fit`,allowUnknown:true,allowEstimatedFit:true}};
        const local=prepareHelarcNativeStructuredInput(request,capacity);
        if(local.assessment.decisions.some(d=>d.conclusion==="violated"))return {...request,inputPreparation:local};
        if("event" in source&&auxiliaryInputs&&context.policy.input.maximumExternalMeasurements>0&&
          requireModelPurpose(request.activity.composition,request.activity.scope.purpose).input.implementation.revision==="3"&&
          request.activity.composition.composition.auxiliary.some(value=>digest(value)===digest(HELARC_RESPONSES_MEASUREMENT_PARTICIPANT)))
          return auxiliaryInputs.prepare(request,capacity,invocation.signal);
        const measured=measurement&&"measurement" in source&&source.measurement?
          await measurement.measureStructured(request,source,invocation.signal):null;
        return {...request,inputPreparation:prepareHelarcNativeStructuredInput(request,capacity,measured?.evidence??[],measured?.refusals)};
      },
      retainTransport:request=>carrier instanceof HelarcResponsesPurposeObserver?
        carrier.prepare(request.activity,request,c,{transport:"http",continuity:"native_replay"}):carrier.prepare(request.activity,request,c),
      execution:{journal:store.protocolJournal,acceptance:store.sharedAcceptance,generation:store.generation,now,
        authorize:(request,ctx)=>check(request.activity,ctx.signal),
        observe:async(state,request,ctx)=>{
          // Representation work already holds the original model admission; Stop work does not.
          if(state.activity.scope.purpose.id==="context_representation")return carrier.observe(state,request,ctx.signal,()=>check(state.activity,ctx.signal,true));
          const record=await observation.observeStructured(state,request,"recover",{signal:ctx.signal,deadlineAt:await scope.deadline(state.activity.scope.runId)});
          if(!record)throw new TypeError("native_auxiliary_observation_unavailable");return record;
        },interrupt:async(state,request,ctx)=>{
          if(state.activity.scope.purpose.id==="context_representation")return carrier.interrupt(state,request,`${state.activity.scope.activityId}:cancel`);
          return observation.observeStructured(state,request,"interrupt",{signal:ctx.signal,deadlineAt:await scope.deadline(state.activity.scope.runId)});
        }}};
    const responses={stream:n.protocol==="openai.responses"?n.stream:false,store:n.protocol==="openai.responses"?n.store:false,
      ...(n.protocol==="openai.responses"?{transport:n.transport,background:n.background,...n.reasoningEffort?{reasoning:{effort:n.reasoningEffort}}:{}}:{})};
    const deepseek={stream:input.deliveryMode==="streaming",...(n.protocol==="deepseek.chat-completions"&&n.thinking!=="default"?{thinking:{type:n.thinking}}:{})};
    const ollama={stream:input.deliveryMode==="streaming",...(n.protocol==="ollama.chat"?{options:{num_ctx:n.contextWindowTokens},...n.think!=="default"?{think:n.think==="enabled"}:{}}:{})};
    const structured=c.protocol==="openai.responses"?createHelarcResponsesStructuredPurposes(structuredPorts,{stream:false,store:responses.store,
      ...(responses.reasoning?{reasoning:responses.reasoning}:{})}):
      c.protocol==="deepseek.chat-completions"?createHelarcDeepSeekStructuredPurposes(structuredPorts,{...deepseek,stream:false}):
        createHelarcOllamaStructuredPurposes(structuredPorts,{...ollama,stream:false});
    const compactMethods=carrier instanceof HelarcResponsesPurposeObserver&&measurement&&purposes.includes(HELARC_RESPONSES_COMPACT_PURPOSE)?bindHelarcResponsesCompactMethods({store,configuration:c,providers,carrier,now,composition,check,measurement,
      allowUnknownCapacity:true,conditions:source=>({input:{id:source.sourceDigest,revision:"1"},authority:ref(permissionBasis),resources:ref(context.id),control:ref("original-admission")})}):null;
    const methods=bindHelarcNativeContextMethods({store,registry,authorize,now,model:structured.methodParticipant,...(compactMethods?{compact:compactMethods.work}:{})});
    const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,authorize:reportCaptureAuthorization(store,scope),now});
    const inputs=bindHelarcNativeTaskInputs({store,registry,methods,publications,host,authorize,now,measurement,purposes,rediscoveryMs:100,settlementWaitMs:5000,
      authorizeDemand:async(demand,signal)=>{await check(demand.plan.activity,signal);if(demand.path.intent.permissionBasis!==permissionBasis)throw new TypeError("native_input_authority_changed");},
      conditions:async(arranged,source)=>{
        const policy=context.policy;
        const compactAvailable=compactMethods&&compactMethods.participants.every(participant=>
          arranged.activity.composition.composition.auxiliary.some(original=>digest(original.purpose)===digest(participant.purpose)&&compactMethods.supports(original)));
        const measurementAvailable=measurement&&purposes.includes(HELARC_NATIVE_MEASURED_ORIGINAL_INPUT_PURPOSE)&&arranged.activity.composition.composition.auxiliary.some(original=>
          digest(original)===digest(HELARC_RESPONSES_MEASUREMENT_PARTICIPANT));
        const previous=n.protocol==="openai.responses"?await readHelarcResponsesTaskContinuation(arranged.prepared,
          {journal:store.protocolJournal,selections:store.contextSelections}):null;
        const incarnation=n.protocol==="openai.responses"&&n.transport==="websocket"&&carrier instanceof HelarcResponsesPurposeObserver?
          carrier.connectionIncarnation(arranged.activity,connection):undefined;
        const targetCapacity=helarcWorkCapacityEvidence(c,now(),context);
        const generationPlanning=await readHelarcNativeGenerationPlanning(store.protocolJournal,arranged.activity);
        const originalBody=JSON.parse(arranged.prepared.wire.body),originalItems=(originalBody.input??originalBody.messages) as Record<string,unknown>[];
        if(!arranged.prepared.workingSources||!Array.isArray(originalItems))throw new TypeError("native_observation_original_sources_missing");
        const observationContinuity=helarcNativeObservationContinuity(arranged.prepared.workingSources,
          c.protocol!=="openai.responses"&&originalItems[0]?.role==="system"?originalItems.slice(1):originalItems);
        const capacity={limits:targetCapacity.limits,
          reservations:[generationPlanning.reservation],policy:{id:"helarc.native-capacity",revision:"1",purpose:arranged.activity.scope.purpose.id,
            basis:`${targetCapacity.basis}; unavailable full-input token counts remain unknown`,allowUnknown:true,allowEstimatedFit:true},
          maximumCombinations:policy.input.maximumCombinations,maximumMeasurements:policy.input.maximumExternalMeasurements};
        return {revision:"1",settingsRevision:context.id,sequence:source.iteration,inputRevision:0,representationContinuity:source.runId,observationContinuity,
          autoPrepare:context.settings.settings.autoRepresentation,...(context.methodComparisonRevision?{methodComparisonRevision:context.methodComparisonRevision}:{}),
          maximumSourceBytes:policy.method.bounds.readBytes,maximumReadBytes:policy.method.bounds.readBytes,
          capacity,generationPlanning,methodCapacity:{...capacity,reservations:targetCapacity.reservations,policy:{...capacity.policy,purpose:"context_representation"}},bounds:policy.method.bounds,
          limits:{maximumStages:policy.method.maximumStages,maximumAttempts:policy.method.maximumAttempts},schedulingScopeId:scopeId,
          resources:[... ["material-read","material-write"].map(capability=>({poolId:localPoolId,capability,units:1})),
            ...["model-access","model-measurement"].map(capability=>({poolId:modelPoolId,capability,units:1}))],
          ...(measurementAvailable&&policy.input.maximumExternalMeasurements>0?{measurement:HELARC_RESPONSES_MEASUREMENT_SELECTION}:{}),
          ...(compactAvailable?{responsesCompact:{purpose:compactMethods!.purpose,probeRequired:true,assessmentModelCalls:compactMethods!.assessmentModelCalls(arranged.activity.composition,policy.method.bounds.modelCalls),
            ...(compactMethods!.assessmentVersion(arranged.activity.composition).requiresInputAdmission?
              {assessmentInput:{capacity:{limits:capacity.limits,reservations:targetCapacity.reservations,
                policy:{...capacity.policy,purpose:compactMethods!.assessmentPurpose.id}},
                maximumMeasurements:measurementAvailable?Math.min(policy.input.maximumExternalMeasurements,compactMethods!.assessmentModelCalls(arranged.activity.composition,policy.method.bounds.modelCalls)):0}}:{})}}:{}),
          ...(n.protocol==="openai.responses"&&purposes.includes(HELARC_RESPONSES_IN_REQUEST_RECEPTION_PURPOSE)?{responsesInRequest:{enabled:n.allowInRequestCompaction,target:providerCompactionTarget(c),
            policy:c.inRequestCompaction??null,transport:n.transport,continuity:n.continuity,background:n.background}}:{}),
          continuity:n.protocol==="openai.responses"?{kind:"responses",policy:n.continuity==="stored-response"?"persistent_chain":n.continuity==="connection-memory"?"connection_memory":"native_replay",
            previous,conditions:{basis:previous?.response?.observation??context.id,authorized:true,disclosureRevision:permissionBasis,
              remoteStorage:n.store,storeResponse:n.store,targetSupport:"established",
              predecessor:previous?.response&&(n.continuity!=="connection-memory"||previous.connectionIncarnation===incarnation)?"available":"unavailable",
              reestablish:true,policyChange:false,connectionMemory:n.allowConnectionMemory,...(incarnation?{connectionIncarnation:incarnation}:{})}}:{kind:"explicit"}};
      }});
    const deliveries=new HelarcNativeReportDelivery(store);
    const reportHandoff=createHelarcReportMaterialHandoff({store,publications,host,rediscoveryMs:100,deliveryContracts:deliveries,assertNewDeliveryAllowed:scope.assertNewDeliveryAllowed,
      binding:async result=>({child:await helarcMaterialRecipient(store,result.correlation.child.run.id),parent:await helarcMaterialRecipient(store,result.correlation.origin.parent.run.id),
        permissionBasis,scopeId,localPoolId,deadlineAt:await scope.deadline(result.correlation.origin.parent.run.id),maximumSourceBytes:8*1024*1024}),
      authorize:async(result,binding,signal)=>{
        signal.throwIfAborted();host.assertAvailable();const child=await original(binding.child.runId);await original(binding.parent.runId);
        const lineage=child.admission!.lineage;
        return result.correlation.origin.root.run.id===rootRunId&&lineage.kind==="descendant"&&lineage.parent.id===binding.parent.runId&&
          lineage.relation.id===result.correlation.relation.ref.id&&binding.permissionBasis===permissionBasis&&
          binding.child.purpose===HELARC_CONTROLLER_CAPABILITY&&binding.parent.purpose===HELARC_CONTROLLER_CAPABILITY;
      }});
    const ports:HelarcNativeTaskCompositionPorts={journal:store.protocolJournal,acceptance:store.sharedAcceptance,generation:store.generation,
      supportsAuxiliary:p=>structured.supports(p)||Boolean(compactMethods?.supports(p)),
      contextSelections:store.contextSelections,deliveries,auxiliary:[...structured.participants,...compactMethods?.participants??[],
        ...measurement?[HELARC_RESPONSES_MEASUREMENT_PARTICIPANT]:[]],
      originalCompositions:()=>retainedCompositions?[retainedCompositions.root,retainedCompositions.delegated]:null,
      metering:{modelInputTokens:"unavailable",modelOutputTokens:"unavailable",costUnits:"unavailable"},
      preparations:{resume:async()=>{host.assertAvailable();host.wake();}},
      conditions:async source=>({input:ref(source.toolExposure.controllerRequestId),authority:ref(permissionBasis),resources:ref(context.id),control:ref("original-admission")}),
      authorizeImport:async(seed,source)=>{
        const member=await original(source.runId),continuation=member.admission!.delegationRequest?.continuation;
        const admission=await store.readProductRun(rootRunId),handoff=admission?.conversationHandoff;
        if(continuation?.sourceChild.id===seed.sourceRunId||handoff&&digest(handoff.seed)===digest(seed))return;
        throw new TypeError("native_conversation_import_not_admitted");
      },inputPreparation:{select:(...args)=>inputs.waiting.select(...args),restore:(...args)=>inputs.waiting.restore(...args),interrupt:(...args)=>inputs.waiting.interrupt(...args),
        replacement:{maximum:context.policy.input.maximumProviderReplacements??0,
          prepare:(...args)=>inputs.waiting.replace(...args),interrupt:(...args)=>inputs.waiting.interrupt(...args)}},
      retainTransport:async selected=>({...selected,prepared:await carrier.prepare(selected.activity,selected.prepared,c)}),
      authorize:(activity,mode,ctx)=>check(activity,mode==="interrupt"?new AbortController().signal:ctx.cancellation.signal),
      observe:(...args)=>observation.observe(...args)};
    const factory=c.protocol==="openai.responses"?createHelarcResponsesTaskExecution(ports,responses):
      c.protocol==="deepseek.chat-completions"?createHelarcDeepSeekTaskExecution(ports,deepseek):createHelarcOllamaTaskExecution(ports,ollama);
    const registered={originalBindingId:permissionBasis,purposes:purposes.bind(registry),
      reconsideration:(owner:string,sub:Parameters<import("./HelarcActivityBindings.js").HelarcActivityBindings["reconsideration"]>[1])=>
        owner==="model-access"?observation.work.lifecycle:owner==="material-source"?
          sub.id===`${sub.binding?.id}:source-lifecycle`?publications.lifecycle:publications.deliveries:
          auxiliaryInputs&&owner==="context-representation"&&sub.id===`${sub.binding?.id}:input-lifecycle`?auxiliaryInputs.lifecycle:
          inputs.reconsideration(owner,sub)??methods.reconsideration(owner,sub)};
    participants={definition:HELARC_NATIVE_RUN_ACTIVITIES,product:{nativeModel,contextMaterials:createHelarcMaterialAccess(store),reportHandoff,
      resourceContributions:createHelarcNativeResourceContributions(store.protocolJournal),
      nativeNarratives:createHelarcNativeNarrativeReader(store.protocolJournal),nativePresentation:createHelarcNativePresentationReader(store.protocolJournal),
      stopEvaluation:structured.stopEvaluation,taskExecution:async binding=>{
        const next=await factory(binding);
        if(composed&&digest(composed.compositions)!==digest(next.compositions))throw new TypeError("native_task_composition_changed");
        retainBindings(next.compositions);composed=next;return next;
      }},compositions(){if(!composed){if(retainedCompositions)return retainedCompositions;throw new TypeError("native_task_composition_unbound");}return {root:composed.compositions[0]!,delegated:composed.compositions[1]!};},
      restoreCompositions(original){retainBindings([original.root,original.delegated]);retainedCompositions=original;},
      prepareActivation:async()=>{if(!composed&&!retainedCompositions)throw new TypeError("native_task_composition_unbound");await scope.prepareActivation();},
      activate:intent=>scope.activate(registered,intent)};
    return participants;
  }};
}
