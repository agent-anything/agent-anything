import {validateOriginalInputAccountScope,type OriginalInputAccountScope} from "./OriginalInputAccountScopes.js";
import {supplyOriginalInputScopedMethod,type OriginalInputScopedMethodSupply} from "./OriginalInputScopedMethod.js";
import {modelInputFromSections} from "@agent-anything/model-interaction/input";

export interface OriginalInputAccountMethodSupply extends OriginalInputScopedMethodSupply<OriginalInputAccountScope> {
  readonly kind:"historical_account";
}
export function supplyOriginalInputAccountMethod(input:Omit<Parameters<typeof supplyOriginalInputScopedMethod<OriginalInputAccountScope>>[0],"kind"|"objective"|"sourceExtentBytes">):OriginalInputAccountMethodSupply {
  validateOriginalInputAccountScope(input.sources,input.scope);
  return {kind:"historical_account",...supplyOriginalInputScopedMethod({...input,kind:"historical_account",
    sourceExtentBytes:Buffer.byteLength(JSON.stringify(modelInputFromSections(input.scope.groups.filter(g=>g.role==="source")
      .flatMap(g=>input.sources.groups.find(s=>s.id===g.id)!.occurrences.map(o=>o.section)))),"utf8"),
    objective:"Create a faithful historical account of the named source scope for continued work. Preserve the source-owned obligations, chronology, correlated actions and actual outcomes, unresolved matters and applicable constraints. Read-only background is not transformed coverage. Do not execute the underlying task or turn failures into success."})};
}
