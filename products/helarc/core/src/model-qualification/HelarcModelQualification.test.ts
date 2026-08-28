import { describe, expect, it } from "vitest";
import {
  HELARC_MODEL_QUALIFICATION_PROTOCOL_REVISION,
  HelarcModelQualificationError,
  createHelarcModelQualificationCatalog,
  createHelarcModelQualificationDecision,
  createHelarcModelQualificationTarget,
  deriveHelarcModelUseDisposition,
  projectHelarcModelQualificationSafe,
  resolveHelarcModelQualificationApplicability,
  type HelarcModelQualificationDecision,
  type HelarcModelQualificationScope,
  type HelarcModelQualificationTarget,
} from "./index.js";

const DATE = "2026-08-28T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("Helarc model qualification", () => {
  it("creates deterministic immutable exact targets and changes identity for material changes", () => {
    const first = target();
    const repeated = target();
    const changed = target({ toolSelectionRevision: "selection-2" });

    expect(repeated).toEqual(first);
    expect(changed.id).not.toBe(first.id);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("api-key");
    expect(JSON.stringify(first)).not.toContain("http://localhost");
  });

  it("preserves immutable decision history and resolves one current supersession head", () => {
    const exactTarget = target();
    const initial = decision("agent-loop", exactTarget, "agent_loop", "inconclusive");
    const successor = decision(
      "agent-loop",
      exactTarget,
      "agent_loop",
      "qualified",
      initial,
    );
    const catalog = createHelarcModelQualificationCatalog({ decisions: [initial, successor] });
    const applicability = resolveHelarcModelQualificationApplicability({
      catalog,
      target: exactTarget,
      scope: "agent_loop",
    });

    expect(applicability.status).toBe("current");
    expect(applicability.decision?.ref).toEqual(successor.ref);
    expect(applicability.decision?.outcome).toBe("qualified");
    expect(catalog.decisions).toHaveLength(2);
    expect(Object.isFrozen(catalog.decisions)).toBe(true);
  });

  it("derives stale only for the same Product model subject and absent for another subject", () => {
    const original = target();
    const catalog = createHelarcModelQualificationCatalog({
      decisions: [decision("agent-loop", original, "agent_loop", "qualified")],
    });
    const stale = resolveHelarcModelQualificationApplicability({
      catalog,
      target: target({ productRevision: "product-2" }),
      scope: "agent_loop",
    });
    const absent = resolveHelarcModelQualificationApplicability({
      catalog,
      target: target({ modelId: "another-model" }),
      scope: "agent_loop",
    });

    expect(stale.status).toBe("stale");
    expect(stale.decision).toBeNull();
    expect(stale.staleDecisionRefs).toHaveLength(1);
    expect(absent.status).toBe("absent");
    expect(absent.staleDecisionRefs).toEqual([]);
  });

  it("derives qualified, experimental, and blocked dispositions without granting authority", () => {
    const exactTarget = target();
    const qualifiedCatalog = createHelarcModelQualificationCatalog({
      decisions: [
        decision("agent-loop", exactTarget, "agent_loop", "qualified"),
        decision("observation", exactTarget, "workspace_observation", "qualified"),
      ],
    });
    const qualified = deriveHelarcModelUseDisposition({
      catalog: qualifiedCatalog,
      target: exactTarget,
      nativeToolInteractionSupported: true,
      requiredScopes: ["agent_loop", "workspace_observation"],
      policy: "require_qualified",
    });
    const missingCatalog = createHelarcModelQualificationCatalog({
      decisions: [decision("agent-loop", exactTarget, "agent_loop", "qualified")],
    });
    const experimental = deriveHelarcModelUseDisposition({
      catalog: missingCatalog,
      target: exactTarget,
      nativeToolInteractionSupported: true,
      requiredScopes: ["agent_loop", "workspace_mutation"],
      policy: "allow_experimental",
    });
    const blockedMissing = deriveHelarcModelUseDisposition({
      catalog: missingCatalog,
      target: exactTarget,
      nativeToolInteractionSupported: true,
      requiredScopes: ["agent_loop", "workspace_mutation"],
      policy: "require_qualified",
    });
    const blockedProtocol = deriveHelarcModelUseDisposition({
      catalog: qualifiedCatalog,
      target: exactTarget,
      nativeToolInteractionSupported: false,
      requiredScopes: ["agent_loop"],
      policy: "allow_experimental",
    });

    expect(qualified.status).toBe("qualified");
    expect(experimental).toMatchObject({
      status: "experimental",
      reasons: ["scope_absent:workspace_mutation"],
    });
    expect(blockedMissing.status).toBe("blocked");
    expect(blockedProtocol).toMatchObject({
      status: "blocked",
      reasons: ["native_tool_interaction_unsupported"],
    });
    expect(qualified).not.toHaveProperty("permission");
    expect(qualified).not.toHaveProperty("execute");
  });

  it("blocks a current not-qualified scope even under explicit experimental policy", () => {
    const exactTarget = target();
    const catalog = createHelarcModelQualificationCatalog({
      decisions: [
        decision("agent-loop", exactTarget, "agent_loop", "qualified"),
        decision("mutation", exactTarget, "workspace_mutation", "not_qualified"),
      ],
    });
    const disposition = deriveHelarcModelUseDisposition({
      catalog,
      target: exactTarget,
      nativeToolInteractionSupported: true,
      requiredScopes: ["agent_loop", "workspace_mutation"],
      policy: "allow_experimental",
    });

    expect(disposition).toMatchObject({
      status: "blocked",
      reasons: ["scope_not_qualified:workspace_mutation"],
    });
  });

  it("projects bounded status without protected target configuration or evidence", () => {
    const exactTarget = target();
    const catalog = createHelarcModelQualificationCatalog({
      decisions: [decision("agent-loop", exactTarget, "agent_loop", "qualified")],
    });
    const disposition = deriveHelarcModelUseDisposition({
      catalog,
      target: exactTarget,
      nativeToolInteractionSupported: true,
      requiredScopes: ["agent_loop"],
      policy: "require_qualified",
    });
    const projection = projectHelarcModelQualificationSafe({
      catalog,
      target: exactTarget,
      disposition,
      toolGuidance: {
        releaseId: "helarc.product-tool-guidance",
        releaseRevision: `sha256:${"f".repeat(64)}`,
        profileRevision: "helarc.product-tool-guidance-profile.v1",
      },
    });
    const serialized = JSON.stringify(projection);

    expect(projection).toMatchObject({
      providerKind: "ollama",
      modelId: "gemma4:e4b",
      status: "qualified",
      experimentalUseSelected: false,
      scopes: [{
        scope: "agent_loop",
        decidedAt: DATE,
      }],
    });
    expect(serialized).not.toContain(DIGEST);
    expect(serialized).not.toContain("evidenceRef");
    expect(serialized).not.toContain("evidenceRefs");
    expect(serialized).not.toContain("binding");
  });

  it("rejects evidence-free decisions, ambiguous heads, invalid supersession, and tampering", () => {
    const exactTarget = target();
    expect(() => createHelarcModelQualificationDecision({
      id: "no-evidence",
      target: exactTarget,
      scope: "agent_loop",
      outcome: "qualified",
      evidenceRefs: [],
      decidedAt: DATE,
      decidedBy: "reviewer",
    })).toThrowError(expect.objectContaining({ code: "model_qualification_evidence_invalid" }));

    const first = decision("first", exactTarget, "agent_loop", "qualified");
    const second = decision("second", exactTarget, "agent_loop", "qualified");
    expect(() => createHelarcModelQualificationCatalog({ decisions: [first, second] }))
      .toThrowError(expect.objectContaining({
        code: "model_qualification_supersession_invalid",
      }));

    const otherTarget = target({ toolSelectionRevision: "selection-2" });
    const crossTarget = decision("cross", otherTarget, "agent_loop", "qualified", first);
    expect(() => createHelarcModelQualificationCatalog({ decisions: [first, crossTarget] }))
      .toThrowError(expect.objectContaining({
        code: "model_qualification_supersession_invalid",
      }));

    expect(() => createHelarcModelQualificationCatalog({
      decisions: [{ ...first, ref: { ...first.ref, revision: `sha256:${"0".repeat(64)}` } }],
    })).toThrowError(expect.objectContaining({ code: "model_qualification_catalog_corrupt" }));
    expect(() => deriveHelarcModelUseDisposition({
      catalog: createHelarcModelQualificationCatalog({ decisions: [first] }),
      target: exactTarget,
      nativeToolInteractionSupported: true,
      requiredScopes: ["workspace_observation"],
      policy: "require_qualified",
    })).toThrowError(HelarcModelQualificationError);
  });
});

function target(
  changes: Partial<Omit<HelarcModelQualificationTarget, "id">> = {},
): HelarcModelQualificationTarget {
  return createHelarcModelQualificationTarget({
    productRevision: "helarc-product-1",
    providerKind: "ollama",
    providerAdapterRevision: "ollama-adapter-1",
    providerCapabilityDigest: DIGEST,
    endpointCompatibilityFamily: "ollama-chat-tools",
    safeProviderConfigurationDigest: DIGEST,
    modelId: "gemma4:e4b",
    modelArtifactRevision: "artifact-1",
    modelIdentityStrength: "immutable",
    modelRuntimeRevision: "ollama-0.20.5",
    generationConfigurationDigest: DIGEST,
    agentInstructionBinding: "instruction-binding-1",
    toolGuidanceBinding: "guidance-binding-1",
    toolSelectionRevision: "selection-1",
    modelInteractionRevision: "native-tools-1",
    operatingProfileRevision: "operating-profile-1",
    qualificationProtocolRevision: HELARC_MODEL_QUALIFICATION_PROTOCOL_REVISION,
    ...changes,
  });
}

function decision(
  id: string,
  qualificationTarget: HelarcModelQualificationTarget,
  scope: HelarcModelQualificationScope,
  outcome: "qualified" | "not_qualified" | "inconclusive",
  supersedes: HelarcModelQualificationDecision | null = null,
) {
  return createHelarcModelQualificationDecision({
    id,
    target: qualificationTarget,
    scope,
    outcome,
    evidenceRefs: [{
      owner: "manual-review",
      kind: "bounded-product-exercise",
      id: `${id}-evidence`,
      revision: "1",
    }],
    limitations: ["Bounded exact-target evidence only."],
    decidedAt: DATE,
    decidedBy: "helarc-reviewer",
    supersedes: supersedes?.ref ?? null,
  });
}
