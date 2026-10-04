import type { ProviderRequestedOutput } from "@agent-anything/model-interaction";
import type { ModelInputSection } from "@agent-anything/model-interaction/input";

export interface ModelOutputRecovery {
  readonly sourceRequestId: string;
  readonly turnId: string;
  readonly attemptNumber: number;
  readonly requestedOutput: ProviderRequestedOutput;
}

/** Technical response feedback, not Agent instructions or accepted model history. */
export function createModelOutputRecoverySection(
  recovery: ModelOutputRecovery | null | undefined,
): ModelInputSection | null {
  if (!recovery) return null;
  const id = `${recovery.sourceRequestId}:output-recovery:${recovery.attemptNumber}`;
  return Object.freeze({
    id,
    source: Object.freeze({ owner: "agent-runtime", kind: "model_output_recovery", id, revision: "1" }),
    kind: "model_output_recovery",
    role: "user",
    necessity: "mandatory",
    content: Object.freeze({
      kind: "text",
      text: `Response recovery: ${JSON.stringify({
        sourceRequestId: recovery.sourceRequestId,
        turnId: recovery.turnId,
        reason: "output_limit",
        attempt: recovery.attemptNumber,
        maximumOutputTokens: recovery.requestedOutput.maximum,
      })}\nThe previous response reached the configured output limit and was rejected. ` +
        "None of its function calls were executed. Generate a shorter, complete response using the same response protocol. " +
        "Do not repeat work already reflected in the supplied history.",
    }),
  });
}
