import { describe, expect, it } from "vitest";
import * as continuationApi from "./continuation/index.js";
import * as inputApi from "./input/index.js";
import type { RetrySchedulerOwnership } from "./index.js";
import * as api from "./index.js";

describe("Model Interaction public API", () => {
  it("exposes focused Model Interaction runtime values from their owner paths", () => {
    expect(Object.keys(api).sort()).toEqual([
      "createModelCallRef",
      "createModelTurnId",
      "createNativeToolTurnInteraction",
      "createProviderAttemptInterruption",
      "modelCallRefKey",
      "modelCallableDefinitionsContentDigest",
      "modelInstructionsEqual",
      "modelMessagesEqual",
      "providerGeneratedOutput",
      "providerInteractionsEqual",
      "providerResponseUsage",
      "providerResultFromInterruption",
      "snapshotModelCallRef",
      "snapshotModelCallableDefinition",
      "snapshotModelCallableDefinitions",
      "snapshotModelInstructions",
      "snapshotModelJsonValue",
      "snapshotModelMessage",
      "snapshotModelMessages",
      "snapshotModelOutputFormat",
      "snapshotModelToolCall",
      "snapshotModelToolResult",
      "snapshotModelTurn",
      "snapshotModelTurnFinish",
      "snapshotProviderCallRef",
      "snapshotProviderCapabilities",
      "snapshotProviderInteraction",
      "snapshotProviderRequest",
      "snapshotProviderResponse",
    ]);
    expect(Object.keys(inputApi).sort()).toEqual([
      "ModelInputCompositionError",
      "allocateModelInputContext",
      "composeModelInput",
      "createUtf8ModelInputAccounting",
      "modelInputFromComposition",
      "modelInputFromSections",
      "snapshotModelInputCapability",
      "snapshotModelInputComposition",
      "snapshotModelOutputFormat",
    ]);
    expect(Object.keys(continuationApi).sort()).toEqual([
      "ModelContinuationLifecycle",
      "checkModelContinuationCompatibility",
      "createInMemoryModelContinuationStore",
      "snapshotModelContinuationCapability",
      "snapshotModelContinuationCompatibility",
      "snapshotModelContinuationOutcome",
      "snapshotModelContinuationRef",
    ]);
  });

  it("uses explicit Harness or SDK request Retry ownership", () => {
    const harness: RetrySchedulerOwnership = { kind: "harness" };
    const sdk: RetrySchedulerOwnership = {
      kind: "sdk",
      sdkName: "example-sdk",
      maxAttempts: 3,
      exposesAttemptEvents: true,
      supportsCancellation: true,
    };

    expect(harness.kind).toBe("harness");
    expect(sdk).toMatchObject({
      kind: "sdk",
      maxAttempts: 3,
      exposesAttemptEvents: true,
      supportsCancellation: true,
    });
  });
});
