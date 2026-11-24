import type {InputMeasurementEvidence,InputCapacityRefusal} from "@agent-anything/model-interaction/input";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import type {ActivityPathIntent,ActivityPathState,ActivityStageState} from "@agent-anything/agent-runtime/activity";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";

/** Frozen supply declaration; observing capacity does not grant input adoption. */
export interface HelarcNativeInputMeasurementSelection {
  readonly purpose:ProtocolRevisionRef;
  readonly methodRevision:string;
  readonly budget?:{readonly pathId:string;readonly maximumCalls:number};
}
export interface HelarcNativeInputMeasurementResult {
  readonly evidence:readonly InputMeasurementEvidence[];
  readonly usage:{readonly measurementCalls:number};
  readonly refusals?:readonly InputCapacityRefusal[];
}
export interface HelarcNativeInputMeasurementPort {
  measure(input:{readonly activity:ProtocolModelActivity;readonly native:HelarcRetainedNativeInput;readonly inputId:string;
    readonly selection:HelarcNativeInputMeasurementSelection},signal:AbortSignal):Promise<HelarcNativeInputMeasurementResult>;
  interrupt(inputId:string,signal:AbortSignal):Promise<void>;
  inStage?(path:ActivityPathState,stage:ActivityStageState):HelarcNativeInputMeasurementPort;
}

export function helarcNativeMeasurementBudget<T extends Omit<ActivityPathIntent,"owner"|"purpose">>(intent:T,
  selection:HelarcNativeInputMeasurementSelection|undefined):T {
  if(!selection?.budget)return intent;
  const {pathId,maximumCalls}=selection.budget;
  if(!pathId||!Number.isSafeInteger(maximumCalls)||maximumCalls<0)throw new TypeError("native_measurement_budget_invalid");
  return {...intent,resourceLimits:{...intent.resourceLimits,measurementCalls:maximumCalls},
    resourceBudgetSources:{...intent.resourceBudgetSources,measurementCalls:pathId}};
}
export function helarcNativeStageMeasurement<T extends {readonly measurement?:HelarcNativeInputMeasurementPort}>(ports:T,
  path:ActivityPathState,stage:ActivityStageState):T {
  if(path.intent.resourceBudgetSources?.measurementCalls&&!ports.measurement?.inStage)throw new TypeError("native_measurement_stage_owner_missing");
  return {...ports,measurement:ports.measurement?.inStage?.(path,stage)??ports.measurement};
}
