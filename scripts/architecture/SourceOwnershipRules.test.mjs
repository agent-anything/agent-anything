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

test("test-only physical fixtures do not violate production result ownership", () => {
  const violations = evaluateSourceOwnershipRules({
    sourcePath: "products/helarc/local-environment/src/command/ProcessExecutor.test.ts",
    text: "const result: ToolResult = fixture;",
    isTestOnly: true,
  });
  assert.deepEqual(violations, []);
});
