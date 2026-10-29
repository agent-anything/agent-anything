import type {ProviderRequest} from "../ProviderRequest.js";
import type {ModelInputMeasurement} from "../context/ModelContext.js";
import type {EncodedModelInput} from "./EncodedModelInput.js";

export interface RemoteInputMeasurementRequest {
  readonly id:string;
  readonly methodRevision:string;
  readonly encodedInputId:string;
  readonly targetRevision:string;
  readonly payload:unknown;
}
/** A remote count has its own durable request/raw return; parsing is a separate responsibility. */
export interface RemoteInputMeasurement {
  readonly revision:string;
  prepare(request:ProviderRequest,encoded:EncodedModelInput):RemoteInputMeasurementRequest;
  send(request:RemoteInputMeasurementRequest,signal:AbortSignal):Promise<unknown>;
  interpret(request:RemoteInputMeasurementRequest,raw:unknown,compositionId:string,measuredAt:string):ModelInputMeasurement;
}
