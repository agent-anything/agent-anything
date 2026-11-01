import type {MethodRelationship,MethodRequirement} from "./methods/RepresentationMethod.js";

/** Frozen source/background evidence and obligations; eligibility belongs to the specific method. */
export interface OriginalInputMethodScope {
  readonly id:string;
  readonly runId:string;
  readonly owner:string;
  readonly groups:readonly {readonly id:string;readonly revision:string;readonly alias:string;readonly role:"source"|"background"}[];
  readonly requirements:readonly MethodRequirement[];
  readonly relationships:readonly MethodRelationship[];
}
