import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {Provider,ProviderCallResult} from "@agent-anything/model-interaction";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityPathState,ActivityStageState,ActivityAttempt,ActivityRawResult} from "../activity/ActivityHandoff.js";
import {validatePreparedContextInput,type PreparedContextInput} from "./ContextInputPreparation.js";

/** Executes a previously accepted input. Interpretation is still supplied by its trusted purpose owner. */
export class PreparedInputExecution implements ActivityPurposeHandler {
  constructor(private readonly dependencies:{
    provider:Provider;
    selections:ContextSelectionPort;
    inputId:(stage:ActivityStageState)=>string;
    authorize:(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal)=>Promise<void>;
    interpret:ActivityPurposeHandler["interpret"];
    reconcile?:ActivityPurposeHandler["reconcile"];
    now:()=>string;
  }) {}
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<void> {
    await this.read(path,stage);await this.dependencies.authorize(path,stage,signal);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    const started=performance.now();
    const binding=await this.read(path,stage),prepared=binding.input.exactInput as PreparedContextInput;
    signal.throwIfAborted();
    await this.dependencies.selections.command({kind:"sent",inputId:binding.input.id,attemptId:attempt.id});
    const dispatchedAt=performance.now();
    const result:ProviderCallResult=await this.dependencies.provider.send(prepared.request,{signal,interruption:null},
      {mode:prepared.encoded.mode,invocationId:attempt.id,encodedInput:prepared.encoded});
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:result,
      usage:{...(result.kind==="succeeded"?(result.response.kind==="native_tool_turn"?result.response.turn.usage:result.response.usage):{}),providerElapsedMs:performance.now()-dispatchedAt,preDispatchMs:dispatchedAt-started},recordedAt:this.dependencies.now()};
  }
  reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    return this.dependencies.reconcile?.(path,stage,signal) ?? Promise.resolve(null);
  }
  interpret(...args:Parameters<ActivityPurposeHandler["interpret"]>) {return this.dependencies.interpret(...args);}
  private async read(path:ActivityPathState,stage:ActivityStageState):Promise<ContextSelectionSnapshot> {
    const binding=await this.dependencies.selections.command({kind:"binding",inputId:this.dependencies.inputId(stage),checkCurrentControl:true}) as ContextSelectionSnapshot;
    if(binding.scope.runId!==path.intent.runId || binding.input.activityId!==path.intent.id || binding.input.stageRequestId!==stage.request.id ||
       modelInputValueDigest(binding.input.exactInput)!==modelInputValueDigest(stage.request.input))throw new TypeError("prepared_input_dispatch_scope_invalid");
    validatePreparedContextInput(binding.input.exactInput as PreparedContextInput);
    const prepared=binding.input.exactInput as PreparedContextInput;
    if(!this.dependencies.provider.verifyEncodedInput)throw new TypeError("prepared_input_verification_unavailable");
    this.dependencies.provider.verifyEncodedInput(prepared.request,prepared.encoded);
    return binding;
  }
}
