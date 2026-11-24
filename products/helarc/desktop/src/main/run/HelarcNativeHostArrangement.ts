import type {CreateHelarcNativeProductCompositionInput} from "@agent-anything/helarc/composition";
import type {ModelAgentCompositionBinding} from "@agent-anything/model-interaction/protocol";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {HelarcActivityHost} from "../context/HelarcRunActivityComposition.js";
import type {HelarcNativeContextRunBinding} from "../context/HelarcNativeContextRunBinding.js";
import type {RetainedConnection} from "../provider/ProviderConnectionRetention.js";

/** The native Host owns participants; the shared Host owns Run admission and execution. */
export interface HelarcNativeHostArrangement {
  readonly configuration:ProviderConfiguration;
  readonly connection:RetainedConnection;
  compose(input:{rootRunId:string;store:HelarcExecutionStore;host:HelarcActivityHost;context:HelarcNativeContextRunBinding;
    deliveryMode:"buffered"|"streaming";now:()=>string}):HelarcNativeHostActivities;
}
export interface HelarcNativeHostActivities {
  readonly definition:{readonly id:string;readonly revision:string};
  readonly product:Pick<CreateHelarcNativeProductCompositionInput,"nativeModel"|"taskExecution"|"stopEvaluation"|
    "nativeNarratives"|"nativePresentation"|"contextMaterials"|"reportHandoff"|"resourceContributions">;
  /** Bound during Product composition, before any Run is admitted or executed. */
  compositions():{root:ModelAgentCompositionBinding;delegated:ModelAgentCompositionBinding};
  restoreCompositions(original:{root:ModelAgentCompositionBinding;delegated:ModelAgentCompositionBinding}):void;
  prepareActivation():Promise<void>;
  activate(intent?:"settle"|"continue"|"cancel"):void;
}
