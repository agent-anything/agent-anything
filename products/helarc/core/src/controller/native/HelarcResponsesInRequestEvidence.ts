import type {TransformationDependencies,TransformationDuty,TransformationFinding,TransformationQuality} from "@agent-anything/context/representation";
import type {RESPONSES_IN_REQUEST_COMPACTION,nativeInputCoverage} from "@agent-anything/provider-integrations/native";
import type {HelarcInRequestCompactionPolicy,HelarcCompactionContent} from "../../configuration/HelarcInRequestCompactionPolicy.js";

export interface HelarcResponsesInRequestUse {
  readonly enabled:boolean;
  readonly target:string;
  readonly policy:HelarcInRequestCompactionPolicy|null;
  readonly transport:"http"|"websocket";
  readonly continuity:"replay"|"stored-response"|"connection-memory";
  readonly background:boolean;
}
export interface HelarcResponsesInRequestEligibility {
  readonly id:string;
  readonly allowed:boolean;
  readonly originalInputDigest:string;
  readonly use:HelarcResponsesInRequestUse;
  readonly profileId:string|null;
  readonly content:readonly HelarcCompactionContent[];
  readonly reasons:readonly string[];
  readonly duties:readonly TransformationDuty[];
  readonly dutyBasis:readonly {readonly id:string;readonly basis:string}[];
  readonly trigger:{readonly tokens:number;readonly window:number;readonly headroom:number;readonly basis:string}|null;
}

export interface HelarcResponsesCompactionAgreement {
  readonly id:string;readonly requestDigest:string;readonly inputDigest:string;readonly dependencies:TransformationDependencies;
  readonly method:typeof RESPONSES_IN_REQUEST_COMPACTION;
  readonly potentialScope:{readonly groups:ReturnType<typeof nativeInputCoverage>;readonly generatedOutput:true;readonly cutoff:"unknown"};
  readonly threshold:{readonly tokens:number;readonly basis:string;readonly window:number;readonly headroom:number;
    readonly measurement:{readonly id:string;readonly requestDigest:string;readonly coverage:"complete"|"partial"|"unknown";
      readonly tokens:number|null;readonly unknowns:readonly string[];readonly acceptedUncertainty:string|null}};
  readonly duties:readonly TransformationDuty[];readonly findings:readonly TransformationFinding[];
  readonly quality:TransformationQuality;readonly retentionBasis:string;readonly recoveryBasis:string;
  readonly useEvidence?:HelarcResponsesInRequestEligibility;
}
