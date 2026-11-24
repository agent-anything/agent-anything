import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ProtocolObservationUnavailable,assertProtocolModelActivityOriginal,readProtocolContent,retainProtocolContent,retainProtocolInputRejection,readProtocolInputRejection,createModelActivityBinding,type ProtocolModelActivity,type ProtocolExecutionJournal,
  type ProtocolExecutionState,type ProtocolPurposeAcceptance,type ProtocolJournalRecord,type ProtocolContentWork} from "@agent-anything/agent-runtime/model-access";
import {ActivityCheckpointError,type SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import {ActivityContinuationCoordinator,createActivityContinuationArrangement} from "@agent-anything/agent-runtime/execution-coordinator";
import {nativeInputBodyDigest} from "@agent-anything/agent-runtime/context-representation";
import {TaskDecisionActivityError,modelRequestInputFailure,createNativeInputDeliveryReceipt,type AgentActivityExecutionContext,type TaskDecisionActivity,type TaskDecisionInputSources,
  type TaskDecisionProposal,validateTaskDecisionProposal,retainTaskDecisionSource} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {recoverHelarcNativeTask} from "./HelarcNativeTaskRecovery.js";
import {helarcNativeTaskDecision} from "./HelarcNativeTaskDecision.js";
import {HelarcProtocolRecoveryController} from "../HelarcProtocolRecoveryController.js";
import {HELARC_NATIVE_REPLACEMENT_CHECKPOINT,nativeReplacementActivityId,readHelarcNativeInputReplacement,confirmHelarcNativeInputReplacement,type HelarcNativeInputReplacement} from "./HelarcNativeInputReplacement.js";
import {acceptHelarcNativeInputReceipt} from "./HelarcNativeInputReceipt.js";

export type {HelarcNativeRunTask} from "./HelarcNativePreparedTask.js";
import type {HelarcNativeRunTask} from "./HelarcNativePreparedTask.js";
export interface HelarcNativeTaskDelivery {
  select(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>):Promise<void>;
  accept(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>,accepted:ProtocolPurposeAcceptance):Promise<void>;
  refused?(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>,evidence:import("@agent-anything/agent-runtime/model-access").ProtocolInputRejectionEvidence):Promise<void>;
}
export interface HelarcNativeTaskExecutionPorts {
  readonly journal:ProtocolExecutionJournal;
  readonly acceptance:SharedAcceptancePort;
  readonly generation:number;
  readonly metering:TaskDecisionActivity["resourceMetering"];
  readonly prepare:(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext)=>Promise<{activity:ProtocolModelActivity;prepared:HelarcNativeRunTask}>;
  readonly interruptPreparation:(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext)=>Promise<void>;
  /** Resolve the original participants and authority; never rebuild an old request from current Settings. */
  readonly authorize:(activity:ProtocolModelActivity,mode:"execute"|"recover"|"interrupt",context:AgentActivityExecutionContext)=>Promise<void>;
  readonly observe:(state:ProtocolExecutionState,prepared:HelarcNativeRunTask,mode:"execute"|"recover"|"interrupt",context:AgentActivityExecutionContext)=>Promise<ProtocolJournalRecord|null>;
  readonly interpret:Parameters<typeof recoverHelarcNativeTask>[0]["interpret"];
  readonly validateOriginalInput:Parameters<typeof recoverHelarcNativeTask>[0]["validateOriginalInput"];
  readonly contextSelections?:Parameters<typeof recoverHelarcNativeTask>[0]["contextSelections"];
  readonly validateDelivery:(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>)=>void;
  readonly validateMaterials?:(proposal:import("./HelarcNativeTask.js").HelarcNativeTaskProposal,runId:string)=>Promise<void>;
  readonly contentWork?:(work:ProtocolContentWork)=>void;
  readonly deliveries?:HelarcNativeTaskDelivery;
  readonly inputRepreparation?:{
    readonly maximum:number;
    readonly capacityRefused:(value:unknown)=>boolean;
    readonly prepare:(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,replacement:HelarcNativeInputReplacement)=>Promise<{activity:ProtocolModelActivity;prepared:HelarcNativeRunTask}>;
    readonly interrupt:(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,replacement:HelarcNativeInputReplacement)=>Promise<void>;
  };
}
interface AcceptedTask {
  readonly format:"helarc.native-task-decision.v1";
  readonly sourceDigest:string;
  readonly proposal:import("./HelarcNativeTask.js").HelarcNativeTaskProposal;
  readonly decision:TaskDecisionProposal<HelarcAgentOutput>;
}

/** One task-purpose consumer. Native transport owns observation/reconciliation; Runner owns local execution. */
export class HelarcNativeTaskExecution implements TaskDecisionActivity<HelarcAgentOutput> {
  readonly historyKind="native_evidence" as const;
  private readonly recovery:HelarcProtocolRecoveryController<HelarcAgentOutput>;
  constructor(private readonly ports:HelarcNativeTaskExecutionPorts){
    this.recovery=new HelarcProtocolRecoveryController({historyKind:this.historyKind,resourceMetering:ports.metering,
      next:(input,context)=>this.run(input,context,"execute") as Promise<TaskDecisionProposal<HelarcAgentOutput>>,
      recover:(input,context)=>this.run(input,context,"recover") as Promise<TaskDecisionProposal<HelarcAgentOutput>>,
      interrupt:(input,context)=>this.run(input,context,"interrupt")});
  }
  get resourceMetering(){return this.ports.metering;}
  next(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext){return this.invoke(input,context,"next");}
  recover(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext){return this.invoke(input,context,"recover");}
  interrupt(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext){return this.recovery.interrupt(input,context);}
  private async invoke(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,mode:"next"|"recover"){
    try{return await this.recovery[mode](input,context);}
    catch(error){
      if(context.cancellation.signal.aborted){
        try{await this.run(input,context,"interrupt");}
        catch(cause){throw new ActivityCheckpointError(`${input.toolExposure.controllerRequestId}:native-interruption`,{cause});}
      }
      throw error;
    }
  }
  private async run(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,mode:"execute"|"recover"|"interrupt"):Promise<TaskDecisionProposal<HelarcAgentOutput>|null> {
    if(input.interaction.kind!=="native_evidence")throw new TypeError("helarc_native_history_required");
    const p=this.ports,sourceDigest=retainTaskDecisionSource(input).id,replacement=readHelarcNativeInputReplacement(input,context,sourceDigest),
      activityId=replacement?.activityId??`${input.toolExposure.controllerRequestId}:native-task`;
    if(replacement)await confirmHelarcNativeInputReplacement(p.journal,replacement,input,context);
    let state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    let prepared:HelarcNativeRunTask;
    if(!state) {
      if(mode==="interrupt"){
        if(replacement){if(!p.inputRepreparation)throw new TypeError("native_input_replacement_owner_missing");await p.inputRepreparation.interrupt(input,context,replacement);}
        else await p.interruptPreparation(input,context);
        return null;
      }
      context.cancellation.signal.throwIfAborted();
      if(replacement&&!p.inputRepreparation)throw new TypeError("native_input_replacement_owner_missing");
      const arranged=replacement?await p.inputRepreparation!.prepare(input,context,replacement):await p.prepare(input,context);prepared=arranged.prepared;
      if(arranged.activity.scope.activityId!==activityId||arranged.activity.scope.runId!==input.runId||prepared.sourceDigest!==sourceDigest||
        prepared.binding.controllerRequestId!==input.toolExposure.controllerRequestId)throw new TypeError("helarc_native_arrangement_mismatch");
      await p.authorize(arranged.activity,mode,context);
      p.validateOriginalInput(prepared.wire.body,prepared.binding,arranged.activity.composition.composition.configuration.model);
      p.validateDelivery(prepared,input);
      const selected=await this.selectedInput(prepared);
      const contextInput=selected?.input.nativeConsumer?{id:selected.input.id,digest:digest(selected.input.exactInput)}:undefined;
      const content=await retainProtocolContent(p.journal,`${activityId}:prepared:${digest(prepared)}`,activityId,Buffer.from(JSON.stringify(prepared)),p.contentWork);
      const result=await p.acceptance.accept({id:`${activityId}:prepare`,scope:input.runId,actor:"execution-coordinator",
        parts:[{owner:"protocol_execution",kind:"prepare",proposal:{activity:arranged.activity,input:content,...(contextInput?{contextInput}:{})}}]});
      if(result.outcome!=="accepted")throw new TypeError(`helarc_native_prepare_rejected:${result.rejection?.code}`);
      state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
    } else {
      prepared=JSON.parse((await readProtocolContent(p.journal,state.input,activityId,32*1024*1024,p.contentWork)).toString()) as HelarcNativeRunTask;
    }
    assertProtocolModelActivityOriginal(state.activity,state.activity);
    if(state.activity.scope.runId!==input.runId||prepared.sourceDigest!==sourceDigest||prepared.binding.controllerRequestId!==input.toolExposure.controllerRequestId||
      digest(prepared.binding.scope)!==digest(state.activity.scope)||prepared.wire.digest!==digest(JSON.parse(prepared.wire.body)))throw new TypeError("helarc_native_original_source_changed");
    await p.authorize(state.activity,mode,context);
    if(mode==="interrupt"){
      if(state.inputRefusal){
        const refusal=await readProtocolInputRejection(p.journal,state);
        if(!refusal)throw new TypeError("native_input_refusal_basis_missing");
        await this.closeRefusedInput(input,context,state,prepared,refusal.observation);
        return null;
      }
      state=await this.claim(state,input.runId);
      if(!state.cancelled){
        const receipt=await p.acceptance.accept({id:`${activityId}:cancel:${state.fence.controlRevision}`,scope:input.runId,actor:"execution-coordinator",
          parts:[{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:state.fence.controlRevision,cancelled:true}}]});
        if(receipt.outcome!=="accepted")throw new TypeError(`helarc_native_cancel_rejected:${receipt.rejection?.code}`);
        state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
      }
      await p.observe(state,prepared,mode,context);
      const accepted=await p.journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
      if(accepted){
        const retained=JSON.parse((await readProtocolContent(p.journal,accepted.result,activityId,32*1024*1024,p.contentWork)).toString()) as AcceptedTask;
        if(retained.format!=="helarc.native-task-decision.v1"||retained.sourceDigest!==sourceDigest||
          !retained.decision.modelItems.some(m=>m.kind==="native_purpose_evidence"&&digest(m.evidence)===digest(accepted.evidence)))
          throw new TypeError("helarc_native_accepted_decision_changed");
        await this.acceptDelivery(prepared,input,accepted);
        return validateTaskDecisionProposal(retained.decision,input);
      }
      return null;
    }
    const selected=await this.selectedInput(prepared,!state.inputRefusal&&!state.accepted);
    if(selected?.input.nativeConsumer&&digest(state.contextInput)!==digest({id:selected.input.id,digest:digest(selected.input.exactInput)}))
      throw new TypeError("helarc_native_context_claim_changed");
    p.validateOriginalInput(prepared.wire.body,prepared.binding,state.activity.composition.composition.configuration.model);
    p.validateDelivery(prepared,input);
    const saved=await p.journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
    if(state.accepted&&!saved)throw new TypeError("helarc_native_accepted_purpose_missing");
    if(saved) {
      const retained=JSON.parse((await readProtocolContent(p.journal,saved.result,activityId,32*1024*1024,p.contentWork)).toString()) as AcceptedTask;
      if(retained.format!=="helarc.native-task-decision.v1"||retained.sourceDigest!==sourceDigest||
        !retained.decision.modelItems.some(m=>m.kind==="native_purpose_evidence"&&digest(m.evidence)===digest(saved.evidence)))
        throw new TypeError("helarc_native_accepted_decision_changed");
      await this.acceptDelivery(prepared,input,saved);
      return validateTaskDecisionProposal(retained.decision,input);
    }
    if(state.inputRefusal){
      if(!p.inputRepreparation)throw new TypeError("native_input_replacement_owner_missing");
      const refusal=await readProtocolInputRejection(p.journal,state);
      if(!refusal||refusal.proof.boundary!==sourceDigest||refusal.proof.bodyDigest!==nativeInputBodyDigest(prepared.wire.body))
        throw new TypeError("native_input_replacement_original_changed");
      await this.replaceRefusedInput(input,context,state,prepared,refusal.observation,replacement);
      return this.run(input,context,mode);
    }
    state=await this.claim(state,input.runId);
    await p.deliveries?.select(prepared,input);
    const observation=await p.observe(state,prepared,mode,context).catch(error=>{
      if(!(error instanceof ProtocolObservationUnavailable)||context.cancellation.signal.aborted)throw error;
      const {activityId:affected,reason,basis}=error.limitation;
      if(affected!==activityId)throw new ActivityCheckpointError("native_observation_limitation_activity_changed",{cause:error});
      throw new TaskDecisionActivityError({kind:"model",failure:{code:"model_response_unavailable",retryable:false,
        message:`The original model response is unavailable (${reason}). No replacement request was sent.`,
        metadata:{activityId,requestId:prepared.binding.requestId,reason,basis}}},"settled_failure",null,{cause:error});
    });
    if(!observation) {
      throw new TypeError("helarc_native_original_response_unresolved");
    }
    if(p.inputRepreparation){
      const value=JSON.parse((await readProtocolContent(p.journal,observation.content,activityId,32*1024*1024,p.contentWork)).toString());
      if(p.inputRepreparation.capacityRefused(value)){
        await this.replaceRefusedInput(input,context,state,prepared,observation,replacement);
        return this.run(input,context,mode);
      }
    }
    const proposal=await recoverHelarcNativeTask({journal:p.journal,activity:state.activity,observation:observation.ref,
      interpret:p.interpret,validateOriginalInput:p.validateOriginalInput,contextSelections:p.contextSelections,observe:p.contentWork});
    if (Array.isArray(proposal.ending?.materialRefs) && proposal.ending.materialRefs.length && !p.validateMaterials) {
      throw new TypeError("helarc_native_material_validation_required");
    }
    await p.validateMaterials?.(proposal,input.runId);
    const receipt=input.inputDelivery?createNativeInputDeliveryReceipt(input.inputDelivery,{kind:"protocol",requestId:prepared.binding.requestId,
      evidence:proposal.evidence,input:{id:state.input.id,revision:"1",digest:state.input.digest},mapping:prepared.delivery}):null;
    const decision=validateTaskDecisionProposal(helarcNativeTaskDecision(proposal,input,receipt),input);
    const retained:AcceptedTask={format:"helarc.native-task-decision.v1",sourceDigest,proposal,decision};
    const result=await retainProtocolContent(p.journal,`${activityId}:decision:${digest(retained)}`,activityId,Buffer.from(JSON.stringify(retained)),p.contentWork);
    const accepted=await p.acceptance.accept({id:`${activityId}:purpose`,scope:input.runId,actor:proposal.evidence.interpreter.id,
      parts:[{owner:"protocol_execution",kind:"purpose",proposal:{fence:state.fence,acceptance:{evidence:proposal.evidence,result,
        effects:proposal.calls.map(c=>({call:c.call,owner:"execution-coordinator"})),deliveries:[]}}}]});
    if(accepted.outcome!=="accepted")throw new TypeError(`helarc_native_purpose_rejected:${accepted.rejection?.code}`);
    if(p.deliveries||prepared.selectedInputId){
      const original=await p.journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance;
      await this.acceptDelivery(prepared,input,original);
    }
    return decision;
  }
  private async replaceRefusedInput(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,
    state:ProtocolExecutionState,prepared:HelarcNativeRunTask,observation:ProtocolJournalRecord,previous:HelarcNativeInputReplacement|null):Promise<void>{
    const p=this.ports,owner=p.inputRepreparation!,activityId=state.activity.scope.activityId;
    if(!context.checkpoints?.compareAndCommit)throw new ActivityCheckpointError("native_input_replacement_dependencies_missing");
    const evidence=await this.closeRefusedInput(input,context,state,prepared,observation);
    const maximum=previous?.maximum??owner.maximum,rejections=[...previous?.rejections??[],evidence];
    if(!Number.isSafeInteger(maximum)||maximum<0)throw new TypeError("native_input_replacement_allowance_invalid");
    const countExhausted=rejections.length>maximum,deadlineElapsed=Date.now()>=Date.parse(context.retry.deadlineAt);
    if(countExhausted||deadlineElapsed)throw new TaskDecisionActivityError(modelRequestInputFailure({activityId,maximum,rejections,
      deadlineAt:context.retry.deadlineAt,reason:countExhausted?(deadlineElapsed?"replacement_count_and_deadline_exhausted":"replacement_count_exhausted"):
        "replacement_deadline_elapsed"}),"settled_failure");
    const activity=createModelActivityBinding({runId:input.runId,activityId:input.toolExposure.controllerRequestId,
      purpose:state.activity.scope.purpose.id,owner:{kind:"task_decision",inputOwner:"context_representation"}});
    const continuation=await new ActivityContinuationCoordinator(context.checkpoints).accept({expectedActivity:activity,maximumContinuations:maximum,
      signal:context.cancellation.signal,assertAvailable:()=>context.auxiliaryUsage?.assertAvailable(),
      arrangement:createActivityContinuationArrangement({activity,sourceRequestId:prepared.binding.requestId,sourceResponseId:null,sequence:rejections.length,
        cause:{kind:"capacity_rejection",location:"provider",code:"provider_context_window_exceeded"}})});
    const rootActivityId=previous?.rootActivityId??activityId;
    const next:HelarcNativeInputReplacement={revision:"1",rootActivityId,activityId:nativeReplacementActivityId(rootActivityId,rejections),
      sourceDigest:prepared.sourceDigest,deadlineAt:context.retry.deadlineAt,maximum,rejections,continuationId:continuation.id};
    await context.checkpoints.compareAndCommit([{key:HELARC_NATIVE_REPLACEMENT_CHECKPOINT,value:previous}],
      [{key:HELARC_NATIVE_REPLACEMENT_CHECKPOINT,value:next}]);
  }
  private async closeRefusedInput(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,
    state:ProtocolExecutionState,prepared:HelarcNativeRunTask,observation:ProtocolJournalRecord){
    const p=this.ports,selected=await this.selectedInput(prepared,false),activityId=state.activity.scope.activityId,
      alreadyRefused=Boolean(state.inputRefusal);
    if(!selected?.input.nativeConsumer)throw new ActivityCheckpointError("native_input_replacement_dependencies_missing");
    const evidence=await retainProtocolInputRejection({state,observation,journal:p.journal,acceptance:p.acceptance,proof:{kind:"protocol_input_rejection",revision:"1",
      scope:selected.scope,boundary:prepared.sourceDigest,inputId:selected.input.id,exactInputDigest:digest(selected.input.exactInput),
      bodyDigest:nativeInputBodyDigest(prepared.wire.body),originalInput:state.input,observation:observation.ref,reason:"input_capacity_exceeded"}});
    // Closure only prevents further native work. It is not task cancellation or delivery acceptance.
    if(!state.cancelled){
      state=await this.claim(state,input.runId);
      const receipt=await p.acceptance.accept({id:`${activityId}:capacity-refused`,scope:input.runId,actor:"execution-coordinator",
        parts:[{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:state.fence.controlRevision,cancelled:true}}]});
      if(receipt.outcome!=="accepted")throw new ActivityCheckpointError(`${activityId}:capacity-refused`);
      state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
    }
    if(!alreadyRefused)await p.observe(state,prepared,"interrupt",context);
    await p.contextSelections!.command({kind:"sent",inputId:selected.input.id,attemptId:prepared.binding.operationId});
    const release=await p.acceptance.accept({id:`${activityId}:refused-input-selection`,scope:input.runId,actor:selected.scope.owner,
      parts:[{owner:"context_delivery",kind:"release_selection",proposal:{inputId:selected.input.id,basis:evidence.evidence.id}}]});
    if(release.outcome!=="accepted")throw new ActivityCheckpointError(`${activityId}:refused-input-selection`);
    if(p.deliveries&&!p.deliveries.refused)throw new ActivityCheckpointError("native_refused_delivery_owner_missing");
    await p.deliveries?.refused?.(prepared,input,evidence);
    return evidence;
  }
  private async claim(state:ProtocolExecutionState,runId:string){
    const p=this.ports,activityId=state.activity.scope.activityId;
    if(state.fence.generation===p.generation&&state.fence.epoch!==0)return state;
    const receipt=await p.acceptance.accept({id:`${activityId}:claim:${p.generation}:${state.fence.epoch}`,scope:runId,
      actor:state.activity.composition.composition.adapter.implementation.id,parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId,expectedEpoch:state.fence.epoch}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`helarc_native_claim_rejected:${receipt.rejection?.code}`);
    return await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
  }
  private async acceptDelivery(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>,accepted:ProtocolPurposeAcceptance) {
    try {
      if(prepared.selectedInputId){
        if(!this.ports.contextSelections)throw new TypeError("helarc_native_selection_port_missing");
        await acceptHelarcNativeInputReceipt(prepared,accepted,{journal:this.ports.journal,acceptance:this.ports.acceptance,selections:this.ports.contextSelections});
      }
      await this.ports.deliveries?.accept(prepared,input,accepted);
    }
    catch(cause) { throw new ActivityCheckpointError(`${prepared.binding.scope.activityId}:input-delivery`,{cause}); }
  }
  private async selectedInput(prepared:HelarcNativeRunTask,checkCurrentControl=true){
    if(!prepared.selectedInputId)return null;
    if(!this.ports.contextSelections)throw new TypeError("helarc_native_selection_port_missing");
    const selected=await this.ports.contextSelections.command({kind:"binding",inputId:prepared.selectedInputId,checkCurrentControl}) as import("@agent-anything/context/selection").ContextSelectionSnapshot;
    const native=selected?.input.exactInput as import("./HelarcNativeInputAcceptance.js").HelarcRetainedNativeInput;
    if(!native||native.kind!=="helarc_native_input"||native.wire.digest!==prepared.wire.digest||selected.input.activityId!==prepared.binding.scope.activityId||
      selected.scope.runId!==prepared.binding.scope.runId||selected.scope.recipient!==prepared.binding.scope.recipientId||selected.scope.purpose!==prepared.binding.scope.purpose.id)
      throw new TypeError("helarc_native_selection_claim_mismatch");
    return selected;
  }
}
