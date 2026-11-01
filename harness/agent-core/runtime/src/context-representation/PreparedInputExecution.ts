import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {Provider,ProviderCallResult,ProviderDeliveryObserver} from "@agent-anything/model-interaction";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityPathState,ActivityStageState,ActivityAttempt,ActivityRawResult} from "../activity/ActivityHandoff.js";
import {validatePreparedContextInput,type PreparedContextInput} from "./ContextInputPreparation.js";
import {prepareProviderAttemptRetry} from "../model-access/ProviderAttemptRecovery.js";
import {acceptedModelInputUsage} from "../model-access/AcceptedModelInputUsage.js";
import {activityInvocationInterruption} from "../activity/ActivityCancellation.js";

/** Executes a previously accepted input. Interpretation is still supplied by its trusted purpose owner. */
export class PreparedInputExecution implements ActivityPurposeHandler {
  constructor(private readonly dependencies:{
    provider:Provider;
    selections:ContextSelectionPort;
    inputId:(stage:ActivityStageState)=>string;
    authorize:ActivityPurposeHandler["authorize"];
    interpret:ActivityPurposeHandler["interpret"];
    reconcile?:ActivityPurposeHandler["reconcile"];
    settle?:ActivityPurposeHandler["settle"];
    observer?:ProviderDeliveryObserver | ((path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal)=>ProviderDeliveryObserver);
    now:()=>string;
  }) {}
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]):ReturnType<ActivityPurposeHandler["authorize"]> {
    await this.read(path,stage,action==="admission"||action==="execution");return this.dependencies.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    const started=performance.now();
    const binding=await this.read(path,stage),prepared=binding.input.exactInput as PreparedContextInput;
    signal.throwIfAborted();
    let observer:ProviderDeliveryObserver|undefined;
    try {observer=typeof this.dependencies.observer==="function"?this.dependencies.observer(path,stage,attempt,signal):this.dependencies.observer;}
    catch { /* Failure to bind optional observation cannot change dispatch facts. */ }
    await this.dependencies.selections.command({kind:"sent",inputId:binding.input.id,attemptId:attempt.id});
    const dispatchedAt=performance.now();
    const result:ProviderCallResult=await this.dependencies.provider.send(prepared.request,{signal,
      get interruption(){return activityInvocationInterruption(signal,path);}},
      {mode:prepared.encoded.mode,invocationId:attempt.id,encodedInput:prepared.encoded,observer});
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:result.kind==="cancellation_unconfirmed"?"unknown":"returned",value:result,
      usage:{...(result.kind==="succeeded"?(result.response.kind==="native_tool_turn"?result.response.turn.usage:result.response.usage):{}),providerElapsedMs:performance.now()-dispatchedAt,preDispatchMs:dispatchedAt-started},recordedAt:this.dependencies.now()};
  }
  reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    return this.dependencies.reconcile?.(path,stage,signal) ?? Promise.resolve(null);
  }
  async interpret(...args:Parameters<ActivityPurposeHandler["interpret"]>) {
    const result=await this.dependencies.interpret(...args);
    const usage=acceptedModelInputUsage(args[1],args[3].id);
    return usage?{...result,participants:[...result.participants??[],{owner:"model_input_usage",kind:"accepted_usage",proposal:usage}]}:result;
  }
  async prepareRetry(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();return prepareProviderAttemptRetry(path,stage,this.dependencies.now());
  }
  async settle(...args:Parameters<NonNullable<ActivityPurposeHandler["settle"]>>) {
    if(!this.dependencies.settle)throw new TypeError("prepared_input_settlement_unavailable");
    return this.dependencies.settle(...args);
  }
  private async read(path:ActivityPathState,stage:ActivityStageState,checkCurrentControl=true):Promise<ContextSelectionSnapshot> {
    const binding=await this.dependencies.selections.command({kind:"binding",inputId:this.dependencies.inputId(stage),checkCurrentControl}) as ContextSelectionSnapshot;
    if(binding.scope.runId!==path.intent.runId || binding.input.activityId!==path.intent.id || binding.input.stageRequestId!==stage.request.id ||
       modelInputValueDigest(binding.input.exactInput)!==modelInputValueDigest(stage.request.input))throw new TypeError("prepared_input_dispatch_scope_invalid");
    validatePreparedContextInput(binding.input.exactInput as PreparedContextInput);
    const prepared=binding.input.exactInput as PreparedContextInput;
    if(!this.dependencies.provider.verifyEncodedInput)throw new TypeError("prepared_input_verification_unavailable");
    this.dependencies.provider.verifyEncodedInput(prepared.request,prepared.encoded);
    return binding;
  }
}
