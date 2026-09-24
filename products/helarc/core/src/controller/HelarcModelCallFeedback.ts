import type { ModelCallRejectionCandidate } from "@agent-anything/agent-runtime/controller";
import type { ModelToolCall } from "@agent-anything/model-interaction";
import type { HelarcModelCallableCatalog } from "./HelarcModelCallableCatalog.js";

const MAX_REJECTED_NAME_PREVIEW_LENGTH = 256;

export function createHelarcUnknownCallableRejection(
  call: ModelToolCall,
  catalog: Pick<HelarcModelCallableCatalog, "definitions">,
): ModelCallRejectionCandidate {
  const displayedName = JSON.stringify(call.name.slice(0, MAX_REJECTED_NAME_PREVIEW_LENGTH));
  const abbreviation = call.name.length > MAX_REJECTED_NAME_PREVIEW_LENGTH
    ? " (name truncated for display)"
    : "";
  const availableNames = catalog.definitions.map(({ name }) => name);
  const message = [
    `Unknown function name ${displayedName}${abbreviation}: this name was not provided in this request. This call was not executed.`,
    `Available function names for this request: ${JSON.stringify(availableNames)}.`,
    availableNames.length === 0
      ? "No functions were available in this request. Do not invent a function name."
      : "To correct the call, consult the function definitions supplied with your current request. Use an exact function name, including any suffix, and arguments matching that function's input schema. Do not shorten or invent names.",
    "Other calls in the same turn have their own results. Check those results; this rejection does not require repeating them.",
  ].join("\n");

  return Object.freeze({
    kind: "model_call_rejection",
    name: call.name,
    code: "model_callable_unknown",
    message,
    modelCallRef: call.modelCallRef,
  });
}
