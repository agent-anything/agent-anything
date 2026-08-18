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
    if (
      /\bapplyContextTransition\s*\(/.test(text) &&
      path !== "harness/context/src/active-context/ContextTransitionApplication.ts" &&
      path !== "harness/agent-core/runtime/src/runner/RunExecution.ts"
    ) {
      reject(
        "active_context_writer",
        "Only Context transition mechanics and Agent Core RunExecution may apply an Active Context transition.",
      );
    }

    const isContextContractSource =
      /^harness\/context\/src\/(?:contract|contribution|active-context|projection)\//.test(path);
    if (
      path.startsWith("harness/context/src/") &&
      /\b(?:ContextUpdate|ContextMessage|ContextObservation|ContextEvidenceRef|ContextMetadata)\b/.test(text)
    ) {
      reject(
        "superseded_context_contract",
        "Superseded category-based Context contracts cannot return to the final Context package.",
      );
    }
    if (
      isContextContractSource &&
      /@agent-anything\/(?:agent-runtime|model-interaction|tools|action-execution|host|helarc)/.test(text)
    ) {
      reject(
        "context_contract_dependency_direction",
        "Context Contracts cannot depend on Runtime implementations, Product, Host, Tool, execution, or Model Interaction owners.",
      );
    }
    if (
      isContextContractSource &&
      /from\s+["'][^"']*(?:tree-sitter|language-server|semantic-search|code-understanding|source-indexer)[^"']*["']/.test(text)
    ) {
      reject(
        "context_semantic_processor_dependency",
        "Context Contracts cannot depend on language, indexing, retrieval, or Code Understanding processors.",
      );
    }
    if (isContextContractSource && /readonly\s+metadata\s*[?:]/.test(text)) {
      reject(
        "context_generic_metadata_escape_hatch",
        "Final Context Contracts require owned typed fields instead of generic metadata.",
      );
    }
    if (
      isContextContractSource &&
      /\b(?:semanticRank|rankByRelevance|semanticSummarize|summarizeContext)\b/.test(text)
    ) {
      reject(
        "context_semantic_processing",
        "Context cannot own semantic ranking or semantic summarization.",
      );
    }

    if (
      path.startsWith("products/helarc/core/src/prompt/") &&
      /@agent-anything\/context\/(?:active-context|contribution)/.test(text)
    ) {
      reject(
        "prompt_context_internal_traversal",
        "Product prompt sources must consume a fixed Context Projection instead of Active Context internals.",
      );
    }

    if (
      path === "harness/model-interaction/src/ProviderRequest.ts" &&
      !/readonly\s+composition\s*:\s*ModelInputComposition\s*;/.test(text)
    ) {
      reject(
        "provider_request_complete_composition",
        "ProviderRequest must carry one complete immutable Model Input Composition.",
      );
    }
    if (
      path === "harness/agent-core/runtime/src/controller/ProviderBackedController.ts" &&
      (!/inputAccounting\.verify\s*\(/.test(text) || !/request\.composition\b/.test(text))
    ) {
      reject(
        "model_input_composition_verification",
        "The Provider-backed Controller must verify final messages against the accepted complete composition.",
      );
    }

    const isCanonicalContextOrRunState =
      path.startsWith("harness/context/src/") ||
      path.startsWith("harness/agent-core/contracts/src/");
    const isHelarcSemanticRecord = path.startsWith("products/helarc/core/src/");
    if (
      (isCanonicalContextOrRunState || isHelarcSemanticRecord) &&
      /\b(?:ModelContinuationRef|ModelOpaqueContinuationState)\b/.test(text)
    ) {
      reject(
        "provider_continuation_authority_leakage",
        "Opaque Provider continuation cannot become Context, Agent Core Run state, or Product semantic state.",
      );
    }

    const isBoundedValidationConsumer =
      path.startsWith("harness/agent-core/contracts/src/") ||
      path.startsWith("harness/context/src/") ||
      path.startsWith("harness/host/src/") ||
      path.startsWith("harness/observability/src/") ||
      path.startsWith("products/helarc/desktop/src/shared/") ||
      /^products\/helarc\/core\/src\/(?:result|run|work-context)\//.test(path);
    if (
      isBoundedValidationConsumer &&
      /\b(?:ValidationExecution(?:Port|Factory)?|ValidationLedgerSnapshot|ValidationRecord|ValidationEvidence|ValidationAssessment|ValidationSubjectSnapshot|ValidationCurrentRequirementState|CheckAttempt|CheckResult)\b/.test(text)
    ) {
      reject(
        "validation_detailed_state_leakage",
        "Canonical state and consumer-facing surfaces must use bounded Validation projections instead of detailed Validation records or execution authority.",
      );
    }

    const isProductValidationSource = path.startsWith("products/helarc/core/src/validation/");
    if (
      isProductValidationSource &&
      /from\s+["']@agent-anything\/(?:action-execution|helarc-local-environment)(?:[/'"]|$)/.test(text)
    ) {
      reject(
        "product_validation_physical_execution_dependency",
        "Product Validation may compose Operations and exact adapters but cannot depend on physical execution, sandbox, or local-environment implementations.",
      );
    }

    const isValidationSource =
      path.startsWith("harness/validation/src/") ||
      path.startsWith("products/helarc/core/src/validation/") ||
      path.startsWith("products/helarc/code-agent/src/validation/");
    if (
      isValidationSource &&
      /from\s+["'][^"']*(?:tree-sitter|language-server|semantic-search|code-understanding|source-indexer|ast-parser|compiler-adapter)[^"']*["']/.test(text)
    ) {
      reject(
        "validation_semantic_processor_dependency",
        "Validation Contracts and composition cannot depend on language-specific or Code Understanding processors.",
      );
    }

    if (
      path === "harness/agent-core/runtime/src/runner/RunExecution.ts" &&
      (
        !/const\s+completion\s*=\s*await\s+this\.evaluateCompletionGate\s*\(/.test(text) ||
        !/if\s*\(completion\.kind\s*===\s*["']succeeded["']\)\s*\{[\s\S]*?this\.settle\s*\(\{\s*status:\s*["']succeeded["']/.test(text)
      )
    ) {
      reject(
        "runner_completion_gate_required",
        "RunExecution must evaluate the Completion Gate and may settle succeeded only from its succeeded branch.",
      );
    }

    if (/\bcreateNoCheckValidationExecutionFactory\b/.test(text)) {
      reject(
        "production_validation_bypass",
        "Production sources cannot provide or consume a no-check Validation execution bypass.",
      );
    }

    const isModelInputContractSource =
      /^harness\/model-interaction\/src\/(?:input|continuation)\//.test(path) ||
      path === "harness/model-interaction/src/ModelInteractionContractValidation.ts";
    if (
      isModelInputContractSource &&
      /@agent-anything\/(?:context|agent-runtime|provider-integrations|helarc)/.test(text)
    ) {
      reject(
        "model_interaction_contract_dependency_direction",
        "Model Interaction input and continuation Contracts cannot depend on Context state, Runtime, Product, or Provider adapter implementations.",
      );
    }

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
