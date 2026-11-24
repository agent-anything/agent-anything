import {assessInputCapacity,modelInputValueDigest as digest,type InputCapacityAssessment,type InputCapacityLimit,
  type InputCapacityPolicy,type InputMeasurementEvidence,type CapacityReservation,type InputCapacityRefusal} from "@agent-anything/model-interaction/input";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";

interface StructuredInputSource {
  readonly source:ProtocolRevisionRef;
  readonly activity:ProtocolModelActivity;
  readonly wire:{readonly body:string;readonly digest:string};
}

export interface HelarcNativeStructuredInputPolicy {
  readonly limits:readonly InputCapacityLimit[];
  readonly reservations:readonly CapacityReservation[];
  readonly policy:InputCapacityPolicy;
}
export interface HelarcNativeStructuredInputPreparation {
  readonly id:string;
  readonly revision:"1";
  readonly source:ProtocolRevisionRef;
  readonly scope:ProtocolModelActivity["scope"];
  readonly inputId:string;
  readonly requestDigest:string;
  readonly capacity:HelarcNativeStructuredInputPolicy;
  readonly measurements:readonly InputMeasurementEvidence[];
  readonly assessment:InputCapacityAssessment;
}

/** This evidence is about the whole native request, not just its source text. */
export function prepareHelarcNativeStructuredInput(request:StructuredInputSource,
  capacity:HelarcNativeStructuredInputPolicy,measured:readonly InputMeasurementEvidence[]=[],
  refusals:readonly InputCapacityRefusal[]=[]):HelarcNativeStructuredInputPreparation {
  const {configuration}=request.activity.composition.composition;
  const targetRevision=`${configuration.configuration.id}:${configuration.configuration.revision}`;
  const inputId=`${request.activity.scope.activityId}:native-input:${request.wire.digest}`;
  if(digest(JSON.parse(request.wire.body))!==request.wire.digest)throw new TypeError("native_structured_input_body_changed");
  const bytes:InputMeasurementEvidence={id:`${inputId}:bytes`,encodedInputId:inputId,targetRevision,
    methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",
    quantity:{kind:"exact",value:Buffer.byteLength(request.wire.body)},basis:"Complete native request including instructions, data, schema and options",uncovered:[]};
  if(measured.some(m=>m.dimension==="request_bytes"))throw new TypeError("native_structured_input_bytes_owner_changed");
  const measurements=[bytes,...measured];
  const assessment=assessInputCapacity({encodedInputId:inputId,targetRevision,purpose:request.activity.scope.purpose.id,...capacity,evidence:measurements,refusals});
  const value={revision:"1" as const,source:request.source,scope:request.activity.scope,inputId,requestDigest:request.wire.digest,
    capacity,measurements,assessment};
  return structuredClone({id:`native-structured-input:${digest(value)}`,...value});
}

export function assertHelarcNativeStructuredInput(request:StructuredInputSource & {readonly inputPreparation?:HelarcNativeStructuredInputPreparation}):void {
  const retained=request.inputPreparation;
  if(!retained)throw new TypeError("native_structured_input_preparation_missing");
  const original=prepareHelarcNativeStructuredInput(request,retained.capacity,retained.measurements.filter(m=>m.dimension!=="request_bytes"),retained.assessment.refusals);
  if(digest(original)!==digest(retained))throw new TypeError("native_structured_input_preparation_changed");
}

/** No native generation was submitted; the source owner decides what can follow. */
export class HelarcNativeStructuredInputUnavailable extends Error {
  readonly code="native_structured_input_unavailable";
  constructor(readonly preparation:HelarcNativeStructuredInputPreparation,readonly reason:"fixed_background"|"complete_input"="complete_input"){super("native_structured_input_unavailable");}
}
