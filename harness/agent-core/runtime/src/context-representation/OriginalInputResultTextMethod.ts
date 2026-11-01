import {validateOriginalInputResultTextScope,type OriginalInputResultTextScope} from "./OriginalInputResultTextScope.js";
import {supplyOriginalInputScopedMethod,type OriginalInputScopedMethodSupply} from "./OriginalInputScopedMethod.js";
import {readModelResultTextSlot} from "@agent-anything/model-interaction/input";

export interface OriginalInputResultTextMethodSupply extends OriginalInputScopedMethodSupply<OriginalInputResultTextScope> {
  readonly kind:"result_text";
}
export function supplyOriginalInputResultTextMethod(input:Omit<Parameters<typeof supplyOriginalInputScopedMethod<OriginalInputResultTextScope>>[0],"kind"|"objective"|"sourceExtentBytes">):OriginalInputResultTextMethodSupply {
  validateOriginalInputResultTextScope(input.sources,input.scope);
  const declaration=input.scope.declaration;
  const content=input.sources.request.composition.sections.find(s=>s.id===declaration.sectionId)!.content;
  if(content.kind!=="model_message"||content.message.role!=="tool")throw new TypeError("original_result_text_message_changed");
  return {kind:"result_text",...supplyOriginalInputScopedMethod({...input,kind:"result_text",
    sourceExtentBytes:Buffer.byteLength(readModelResultTextSlot(content.message,declaration.slot),"utf8"),
    objective:`Create a faithful shorter representation of ONLY the source-declared result text: section ${declaration.sectionId}, call ${declaration.slot.callId}, content path ${JSON.stringify(declaration.slot.contentPath)}. The result envelope, other fields, original call and sibling results are unchanged read-only evidence, not text to rewrite. Preserve the declared obligations, useful findings, scope, failures, unresolved work and uncertainty. This is a result body for its recipient, not a historical account of an exchange already received. Do not execute or repeat the underlying task. Return the represented body text only.`})};
}
