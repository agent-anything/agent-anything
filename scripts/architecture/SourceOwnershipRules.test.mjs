import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSourceOwnershipRules } from "./SourceOwnershipRules.mjs";

test("accepts current owner-directed source forms", () => {
  const fixtures = [
    {
      sourcePath: "harness/agent-core/runtime/src/runner/RunConfig.ts",
      text: 'import type { WorkspaceSelection } from "@agent-anything/workspace/selection";',
    },
    {
      sourcePath: "products/helarc/core/src/run/HelarcRunProjection.ts",
      text: 'const status = "waiting_for_approval";',
    },
    {
      sourcePath: "products/helarc/desktop/src/main/provider/createHelarcProvider.ts",
      text: 'import { OllamaProvider } from "@agent-anything/provider-integrations/ollama";',
    },
    {
      sourcePath: "harness/tools/src/result/ToolResult.ts",
      text: "export interface ToolResult {}",
    },
    {
      sourcePath: "tooling/test-support/src/conformance/CatalogRealization.ts",
      text: "export interface CatalogRealizationRecord {}",
    },
    {
      sourcePath: "products/helarc/core/src/verification/HelarcVerificationComposition.ts",
      text: [
        'import type { CompositeDefinition } from "@agent-anything/operation-composition/definition";',
        'import type { CodeSourcePort } from "@agent-anything/helarc-code-agent/source";',
      ].join("\n"),
    },
    {
      sourcePath: "harness/agent-core/runtime/src/runner/RunExecution.ts",
      text: [
        "const completion = await this.evaluateCompletionGate(turn, output);",
        'if (completion.kind === "succeeded") { return this.settle({ status: "succeeded" }); }',
      ].join("\n"),
    },
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(evaluateSourceOwnershipRules(fixture), []);
  }
});

test("rejects Tool-to-Action binding and imports from obsolete Action owners", () => {
  const binding = evaluateSourceOwnershipRules({
    sourcePath: "harness/tools/src/registration/ToolRegistration.ts",
    text: "readonly boundActionName: string;",
  });
  const imports = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/composition/Legacy.ts",
    text: [
      'import type { Action } from "@agent-anything/agent-core/action";',
      'import type { Prepared } from "@agent-anything/action-execution/preparation";',
    ].join("\n"),
  });

  assert.deepEqual(binding.map(({ rule }) => rule), ["tool_operation_binding_required"]);
  assert.deepEqual(imports.map(({ rule }) => rule), ["canonical_action_owner_import_required"]);
});

test("rejects ToolResult in production physical execution owners", () => {
  for (const sourcePath of [
    "harness/safety/action-execution/src/execution/ActionExecutor.ts",
    "harness/safety/action-execution/src/sandbox/SandboxContracts.ts",
    "products/helarc/local-environment/src/command/ProcessExecutor.ts",
  ]) {
    const violations = evaluateSourceOwnershipRules({
      sourcePath,
      text: "function execute(): ToolResult {}",
    });
    assert.deepEqual(violations.map(({ rule }) => rule), ["physical_tool_result_leakage"]);
  }
});

test("rejects Approval-specific Harness Run lifecycle", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "harness/agent-core/runtime/src/run/RunStatus.ts",
    text: 'export type RunStatus = "waiting_for_approval";',
  });
  assert.deepEqual(violations.map(({ rule }) => rule), ["approval_specific_run_lifecycle"]);
});

test("rejects catalog realization registry symbols outside Test Support", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "harness/operation-catalog/src/catalog/Realization.ts",
    text: "export const CATALOG_REALIZATION_REGISTRY = [];",
  });
  assert.deepEqual(violations.map(({ rule }) => rule), ["realization_registry_owner"]);
});

test("rejects Provider HTTP transport reimplemented in Desktop", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/desktop/src/main/provider/LocalTransport.ts",
    text: 'return fetch(`${baseUrl}/chat/completions`);',
  });
  assert.deepEqual(violations.map(({ rule }) => rule), ["desktop_provider_transport_implementation"]);
});

test("rejects semantic processors and generic metadata in final Context Contracts", () => {
  const semanticDependency = evaluateSourceOwnershipRules({
    sourcePath: "harness/context/src/projection/ContextProjection.ts",
    text: 'import { rank } from "@vendor/semantic-search";',
  });
  const metadataEscapeHatch = evaluateSourceOwnershipRules({
    sourcePath: "harness/context/src/contribution/ContextContribution.ts",
    text: "readonly metadata?: Record<string, unknown>;",
  });

  assert.deepEqual(
    semanticDependency.map(({ rule }) => rule),
    ["context_semantic_processor_dependency"],
  );
  assert.deepEqual(
    metadataEscapeHatch.map(({ rule }) => rule),
    ["context_generic_metadata_escape_hatch"],
  );
});

test("rejects Context, Runtime, Product, and adapter ownership in Model Interaction Contracts", () => {
  for (const sourcePath of [
    "harness/model-interaction/src/continuation/ModelContinuation.ts",
    "harness/model-interaction/src/ModelMessage.ts",
    "harness/model-interaction/src/ModelInteractionContractValidation.ts",
  ]) {
    const violations = evaluateSourceOwnershipRules({
      sourcePath,
      text: 'import { state } from "@agent-anything/context/active-context";',
    });

    assert.deepEqual(
      violations.map(({ rule }) => rule),
      ["model_interaction_contract_dependency_direction"],
    );
  }
});

test("rejects Active Context transition application outside RunExecution", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/controller/HelarcController.ts",
    text: "const next = applyContextTransition(candidate);",
  });

  assert.deepEqual(
    violations.map(({ rule }) => rule),
    ["active_context_writer"],
  );
});

test("rejects superseded Context categories and semantic processing", () => {
  const superseded = evaluateSourceOwnershipRules({
    sourcePath: "harness/context/src/active-context/Legacy.ts",
    text: "export interface ContextUpdate { observations: ContextObservation[] }",
  });
  const semantic = evaluateSourceOwnershipRules({
    sourcePath: "harness/context/src/projection/SemanticProjection.ts",
    text: "const ordered = rankByRelevance(items);",
  });

  assert.deepEqual(superseded.map(({ rule }) => rule), ["superseded_context_contract"]);
  assert.deepEqual(semantic.map(({ rule }) => rule), ["context_semantic_processing"]);
});

test("rejects prompt traversal of Active Context internals", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/prompt/LegacyPrompt.ts",
    text: 'import type { ActiveContext } from "@agent-anything/context/active-context";',
  });

  assert.deepEqual(
    violations.map(({ rule }) => rule),
    ["prompt_context_internal_traversal"],
  );
});

test("protects the Helarc Tool Contract authority boundary", () => {
  const executableTool = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/tools/HelarcBaselineToolContracts.ts",
    text: "interface ToolContract { readonly executor: unknown; }",
  });

  assert.deepEqual(
    executableTool.map(({ rule }) => rule),
    ["helarc_tool_contract_execution_leakage"],
  );
});

test("protects Product Tool Guidance and model qualification semantic owners", () => {
  const guidanceDependency = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/tools/guidance/InvalidGuidance.ts",
    text: 'import type { Runner } from "@agent-anything/agent-runtime/runner";',
  });
  const guidanceAllowedDependency = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/tools/guidance/ValidGuidance.ts",
    text: 'import type { ToolRevisionRef } from "@agent-anything/tools/identity";',
  });
  const guidanceOwner = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/controller/InvalidGuidance.ts",
    text: "export interface HelarcToolGuidanceRelease {}",
  });
  const qualificationDependency = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/model-qualification/InvalidQualification.ts",
    text: 'import type { ModelInputComposition } from "@agent-anything/model-interaction";',
  });
  const qualificationOwner = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/configuration/InvalidQualification.ts",
    text: "export interface HelarcModelQualificationDecision {}",
  });

  assert.deepEqual(guidanceDependency.map(({ rule }) => rule), [
    "helarc_tool_guidance_dependency_direction",
  ]);
  assert.deepEqual(guidanceAllowedDependency, []);
  assert.deepEqual(guidanceOwner.map(({ rule }) => rule), [
    "helarc_tool_guidance_owner",
  ]);
  assert.deepEqual(qualificationDependency.map(({ rule }) => rule), [
    "helarc_model_qualification_dependency_direction",
  ]);
  assert.deepEqual(qualificationOwner.map(({ rule }) => rule), [
    "helarc_model_qualification_owner",
  ]);
});

test("requires complete Provider composition and Controller verification", () => {
  const request = evaluateSourceOwnershipRules({
    sourcePath: "harness/model-interaction/src/ProviderRequest.ts",
    text: "export interface ProviderRequest { readonly messages: readonly unknown[]; }",
  });
  const controller = evaluateSourceOwnershipRules({
    sourcePath: "harness/agent-core/runtime/src/controller/ProviderBackedController.ts",
    text: "return provider.send(request);",
  });

  assert.deepEqual(
    request.map(({ rule }) => rule),
    ["provider_request_complete_composition"],
  );
  assert.deepEqual(
    controller.map(({ rule }) => rule),
    ["model_input_composition_verification"],
  );
});

test("rejects opaque Provider continuation in canonical Context, Run, and Product state", () => {
  for (const sourcePath of [
    "harness/context/src/active-context/ActiveContext.ts",
    "harness/agent-core/contracts/src/run/RunState.ts",
    "products/helarc/core/src/work-context/HelarcWorkContext.ts",
  ]) {
    const violations = evaluateSourceOwnershipRules({
      sourcePath,
      text: "readonly continuation: ModelContinuationRef;",
    });
    assert.deepEqual(
      violations.map(({ rule }) => rule),
      ["provider_continuation_authority_leakage"],
    );
  }
});

test("rejects detailed Verification authority in bounded state and consumer surfaces", () => {
  for (const sourcePath of [
    "harness/agent-core/contracts/src/run/RunState.ts",
    "harness/context/src/projection/ContextProjection.ts",
    "harness/host/src/projection/HostRunProjection.ts",
    "harness/observability/src/projection/RunTraceProjection.ts",
    "products/helarc/core/src/result/HelarcProductResult.ts",
    "products/helarc/desktop/src/shared/HelarcMainSnapshot.ts",
  ]) {
    const violations = evaluateSourceOwnershipRules({
      sourcePath,
      text: "readonly verification: VerificationLedgerSnapshot;",
    });
    assert.deepEqual(
      violations.map(({ rule }) => rule),
      ["verification_detailed_state_leakage"],
    );
  }
});

test("rejects physical execution and semantic processor dependencies in Verification owners", () => {
  const physical = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/core/src/verification/PhysicalVerification.ts",
    text: 'import { executor } from "@agent-anything/helarc-local-environment/command";',
  });
  const semantic = evaluateSourceOwnershipRules({
    sourcePath: "harness/verification/src/execution/LanguageVerification.ts",
    text: 'import { parse } from "@vendor/tree-sitter-typescript";',
  });

  assert.deepEqual(
    physical.map(({ rule }) => rule),
    ["product_verification_physical_execution_dependency"],
  );
  assert.deepEqual(
    semantic.map(({ rule }) => rule),
    ["verification_semantic_processor_dependency"],
  );
});

test("requires the Runner Completion Gate before success settlement", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "harness/agent-core/runtime/src/runner/RunExecution.ts",
    text: 'return this.settle({ status: "succeeded" });',
  });

  assert.deepEqual(
    violations.map(({ rule }) => rule),
    ["runner_completion_gate_required"],
  );
});

test("rejects production no-check Verification factories", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "harness/verification/src/execution/NoCheckFactory.ts",
    text: "export function createNoCheckVerificationExecutionFactory() {}",
  });

  assert.deepEqual(
    violations.map(({ rule }) => rule),
    ["production_verification_bypass"],
  );
});

test("test-only physical fixtures do not violate production result ownership", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/local-environment/src/command/ProcessExecutor.test.ts",
    text: "const result: ToolResult = fixture;",
    isTestOnly: true,
  });
  assert.deepEqual(violations, []);
});
