import { describe, expect, it } from "vitest";
import * as continuationApi from "./continuation/index.js";
import * as inputApi from "./input/index.js";
import * as contextApi from "./context/index.js";
import type { RetrySchedulerOwnership } from "./index.js";
import * as api from "./index.js";
import * as protocolApi from "./protocol/index.js";

describe("Model Interaction public API", () => {
  it("exposes focused Model Interaction runtime values from their owner paths", () => {
    expect(Object.keys(api).sort()).toEqual([
      "ProviderDeliverySession",
      "accountProviderTransport",
      "assessModelContext",
      "createModelCallRef",
      "createModelTurnId",
      "createNativeModelCallRef",
      "createNativeToolTurnInteraction",
      "createProviderAttemptInterruption",
      "createProviderSemanticRequestDigest",
      "createUnknownModelInputMeasurement",
      "modelCallRefKey",
      "modelCallableDefinitionsContentDigest",
      "modelCallsShareDecisionBasis",
      "modelInstructionsEqual",
      "modelMessagesEqual",
      "providerGeneratedOutput",
      "providerInteractionsEqual",
      "providerResponseUsage",
      "providerResultFromInterruption",
      "publishProviderDelivery",
      "requireModelCallTurn",
      "resolveModelThinkingSelection",
      "snapshotModelCallRef",
      "snapshotModelCallableDefinition",
      "snapshotModelCallableDefinitions",
      "snapshotModelCallableRequest",
      "snapshotModelContextAssessment",
      "snapshotModelInstructions",
      "snapshotModelJsonValue",
      "snapshotModelMessage",
      "snapshotModelMessages",
      "snapshotModelOutputFormat",
      "snapshotModelReasoning",
      "snapshotModelResultPresentation",
      "snapshotModelThinkingCapability",
      "snapshotModelThinkingSelection",
      "snapshotModelToolResult",
      "snapshotModelToolResultContent",
      "snapshotModelTurn",
      "snapshotModelTurnFinish",
      "snapshotProviderCallRef",
      "snapshotProviderCapabilities",
      "snapshotProviderFailure",
      "snapshotProviderInteraction",
      "snapshotProviderRequest",
      "snapshotProviderResponse",
      "snapshotProviderUsage",
      "verifyProviderTransportAccounting",
    ]);
    expect(Object.keys(protocolApi).sort()).toEqual([
      "DEEPSEEK_CHAT_COMPLETIONS", "ModelCompositionRegistry", "ModelProtocolBindingError", "OLLAMA_CHAT", "OPENAI_RESPONSES",
      "assertChildModelComposition", "bindModelAgentComposition", "decodeModelArguments", "nativeModelSourceKey", "requireModelPurpose",
      "sameProtocolRef", "sameRevisionRef", "snapshotModelAgentCompositionBinding", "snapshotModelInteractionProtocol", "snapshotModelInteractionScope",
      "snapshotModelProtocolConfiguration", "snapshotModelProtocolParticipant", "snapshotModelPurposeEvidence", "snapshotModelSchemaMapping",
      "snapshotNativeModelSource", "snapshotProtocolRevisionRef",
    ]);
    expect(Object.keys(inputApi).sort()).toEqual([
      "ModelInputCompositionError",
      "ModelInputEncodingUnsupportedError",
      "RemoteInputMeasurementNotDispatchedError",
      "accountObligations",
      "accountRelationships",
      "allocateInputCapacity",
      "applyModelInputAccounts",
      "applyModelInputOwnerForms",
      "assertEncodedModelInputIntegrity",
      "assessInputCapacity",
      "chargeInputCombination",
      "composeInputChoice",
      "composeModelInput",
      "createAcceptedInputUsage",
      "createEncodedModelInput",
      "createExactModelWorkingView",
      "createOwnerModelWorkingView",
      "declareModelResultContentTextSlot",
      "declareModelResultTextSlot",
      "fillModelResultContentTextSlots",
      "fillModelResultTextSlot",
      "fillModelResultTextSlots",
      "inputAccountingFootprint",
      "inputChoiceGaps",
      "inputChoiceId",
      "measureFromAcceptedUsage",
      "modelInputFromComposition",
      "modelInputFromSections",
      "modelInputOccurrenceDigest",
      "modelInputSectionLocations",
      "modelInputValueDigest",
      "nextInputCombination",
      "organizeOriginalInput",
      "readModelResultContentTextSlot",
      "readModelResultTextSlot",
      "recordInputCombination",
      "selectModelWorkingView",
      "snapshotModelInputComposition",
      "snapshotModelInputPreservation",
      "snapshotModelInputSection",
      "snapshotModelInputSourceRef",
      "snapshotModelOutputFormat",
      "startInputCombinationSearch",
      "validateAcceptedInputUsage",
      "validateInputDemand",
      "validateModelAccountScope",
      "verifyEncodedModelInput",
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
    expect(Object.keys(contextApi).sort()).toEqual([
      "CONTEXT_ACCOUNT_METHOD", "CONTEXT_ASSESSMENT_CRITERIA", "MODEL_INPUT_ALLOCATION_GROUPS", "allocateModelInput", "assessModelContext",
      "contextAssessmentAllowsAccount", "contextTransformationFormat", "contextTransformationNodeBasis", "contextTransformationPrefixLimit", "createContextTransformationBasis", "createContextTransformationRequest", "createModelNativeInputFootprint",
      "createUnknownModelInputMeasurement", "observeModelInputUsage", "parseContextAccountAssessment", "parseContextGeneratedAccount", "planContextTransformationStages", "planModelInput", "renderContextAccount", "snapshotModelContextAssessment",
      "snapshotModelContextCapacity", "snapshotModelContextHeadroom", "snapshotModelInputMeasurement", "snapshotModelInputPlanning", "snapshotModelInputUsageObservation",
      "snapshotProviderInputPreservationConformance", "snapshotProviderModelTarget", "snapshotProviderRequestedOutput",
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
