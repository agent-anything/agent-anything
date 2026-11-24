import type {RepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";
import type {HelarcNativeWorkingGroup} from "./HelarcNativeWorkingSources.js";

/** Source-owned obligations; this mapping does not infer requirements from task prose. */
export function helarcNativeInputRequirements(groups:readonly HelarcNativeWorkingGroup[]):RepresentationMethodRequest["requirements"]{
  return groups.flatMap(g=>g.preservation.obligations.map(o=>({id:`${g.id}:${o.id}`,revision:helarcNativeWorkingGroupRevision(g),
    basis:`Source-owned native preservation ${g.id}`,description:o.basis})));
}
