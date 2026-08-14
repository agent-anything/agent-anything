const TEST_SUPPORT_SOURCE_PREFIX = "tooling/test-support/src/";
const REALIZATION_REGISTRY_SYMBOL =
  /\b(?:[A-Z0-9_]*CATALOG_REALIZATION_REGISTRY|[A-Za-z0-9_]*CatalogDisposition|[A-Za-z0-9_]*CatalogRealizationRecord)\b/;

export function evaluateSourceOwnershipRules({
  sourcePath,
  text,
  isTestOnly = false,
}) {
  const path = sourcePath.replaceAll("\\", "/");
  const violations = [];
  const reject = (rule, message) => violations.push(Object.freeze({ rule, message }));

  if (/\bboundActionName\b/.test(text)) {
    reject(
      "tool_operation_binding_required",
      "Tool registration must bind an Operation revision instead of an Action name.",
    );
  }
  if (
    /@agent-anything\/agent-core\/action(?:[/'"]|$)/.test(text) ||
    /@agent-anything\/action-execution\/(?:canonical|preparation)(?:[/'"]|$)/.test(text)
  ) {
    reject(
      "canonical_action_owner_import_required",
      "Canonical Action contracts must be imported from their current semantic owners.",
    );
  }

  if (!isTestOnly) {
    const isPhysicalExecutionSource =
      path.startsWith("harness/safety/action-execution/src/execution/") ||
      path.startsWith("harness/safety/action-execution/src/sandbox/") ||
      path.startsWith("products/helarc/local-environment/src/");
    if (isPhysicalExecutionSource && /\bToolResult\b/.test(text)) {
      reject(
        "physical_tool_result_leakage",
        "Physical execution sources must return physical outcomes, not ToolResult.",
      );
    }
    if (
      path.startsWith("harness/agent-core/") &&
      /\bwaiting_for_approval\b/.test(text)
    ) {
      reject(
        "approval_specific_run_lifecycle",
        "Harness Run lifecycle must derive waiting from pending subjects instead of an Approval-specific status.",
      );
    }
    if (
      path.startsWith("products/helarc/desktop/src/main/provider/") &&
      (/\bfetch\s*\(/.test(text) || /\/(?:chat\/completions|api\/generate)\b/.test(text))
    ) {
      reject(
        "desktop_provider_transport_implementation",
        "Desktop may configure Provider adapters but must not implement Provider HTTP transport.",
      );
    }
  }

  if (
    !path.startsWith(TEST_SUPPORT_SOURCE_PREFIX) &&
    REALIZATION_REGISTRY_SYMBOL.test(text)
  ) {
    reject(
      "realization_registry_owner",
      "Catalog realization dispositions belong only to Test Support.",
    );
  }

  return Object.freeze(violations);
}
