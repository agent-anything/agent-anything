import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { DelegationOriginCorrelation } from "@agent-anything/agent-core/delegation";
import type { ToolCall } from "@agent-anything/tools/invocation";
import { describe, expect, it } from "vitest";
import {
  createFailedRunResult,
  createRunFailureCause,
  createSucceededRunResult,
} from "../run/index.js";
import {
  createDelegationContextMaterial,
  createDelegationContextPlan,
  createDelegationLimits,
  createDelegationResultExpectation,
  materializeDelegationRequest,
  snapshotDelegationRequest,
  type DelegationPreparation,
} from "./DelegationRequest.js";
import {
  deriveDelegationAuthority,
  snapshotDelegationAuthorityDerivation,
  type DelegationAuthorityDimensionInput,
  type DelegationAuthoritySourceInput,
  type DelegationAuthoritySourceRole,
} from "./DelegationAuthority.js";
import {
  deriveDelegationLimits,
  snapshotDelegationLimitDerivation,
  type DelegationLimitSourceInput,
  type DelegationLimitSourceRole,
} from "./DelegationResources.js";
import {
  createDelegationResult,
  snapshotDelegationResult,
} from "./DelegationResult.js";
import { snapshotDelegationSteeringRoute } from "./DelegationControl.js";

const CHILD_AGENT: AgentRevisionRef = Object.freeze({
  id: "agent-child",
  revision: "agent-child-v1",
});

describe("delegation authority", () => {
  it("intersects allowed authority, unions required constraints, and uses the earliest deadline", () => {
    const authority = authorityDerivation();
    const tool = authority.effective.find((dimension) => dimension.kind === "tool")!;
    const verification = authority.effective.find(
      (dimension) => dimension.kind === "verification",
    )!;

    expect(tool.allowed).toEqual(["tool:read"]);
    expect(verification.required).toEqual([
      "verification:parent",
      "verification:root",
    ]);
    expect(authority.deadlineAt).toBe("2026-08-25T00:06:00.000Z");
    expect(Object.isFrozen(authority.sources)).toBe(true);
    expect(snapshotDelegationAuthorityDerivation(authority)).toEqual(authority);
  });

  it("rejects incomplete authority-source coverage", () => {
    expect(() => deriveDelegationAuthority({
      derivationId: "authority-1",
      sources: authoritySources().slice(0, 2),
    })).toThrow(/root, parent, and current-policy/);
  });

  it("rejects a forged effective authority snapshot", () => {
    const authority = authorityDerivation();
    const forged = {
      ...authority,
      effective: authority.effective.map((dimension) =>
        dimension.kind === "tool"
          ? { ...dimension, allowed: ["tool:read", "tool:write"] }
          : dimension,
      ),
    };

    expect(() => snapshotDelegationAuthorityDerivation(forged)).toThrow(
      /effective result is inconsistent/,
    );
  });
});

describe("delegation resources", () => {
  it("derives every effective limit as the narrowest exact source ceiling", () => {
    const derivation = limitDerivation();

    expect(derivation.effective.maxControllerTurns).toBe(5);
    expect(derivation.effective.maxActions).toBe(16);
    expect(snapshotDelegationLimitDerivation(derivation)).toEqual(derivation);
  });

  it("rejects forged effective limits and incomplete source coverage", () => {
    const derivation = limitDerivation();
    expect(() => snapshotDelegationLimitDerivation({
      ...derivation,
      effective: createDelegationLimits({
        maxControllerTurns: 99,
        maxActions: derivation.effective.maxActions,
        maxModelInputTokens: derivation.effective.maxModelInputTokens,
        maxModelOutputTokens: derivation.effective.maxModelOutputTokens,
        maxCostUnits: derivation.effective.maxCostUnits,
        maxDurationMs: derivation.effective.maxDurationMs,
        maxContextBytes: derivation.effective.maxContextBytes,
        maxResultBytes: derivation.effective.maxResultBytes,
      }),
    })).toThrow(/effective limits are inconsistent/);

    expect(() => deriveDelegationLimits({
      derivationId: "limit-derivation",
      sources: limitSources().slice(0, 3),
    })).toThrow(/every exact source role/);
  });
});

describe("delegation request", () => {
  it("materializes one deterministic immutable request without a child Run identity", () => {
    const first = request();
    const second = request();

    expect(first.ref).toEqual(second.ref);
    expect(first.contextPlan.entries).toHaveLength(1);
    expect(first).not.toHaveProperty("childRun");
    expect(first).not.toHaveProperty("relation");
    expect(Object.isFrozen(first.contextPlan.entries)).toBe(true);
    expect(snapshotDelegationRequest(first)).toEqual(first);
  });

  it("rejects a descendant binding for another Agent revision", () => {
    expect(() => request({
      toolCall: {
        ...toolCall(),
        binding: {
          kind: "descendant_agent",
          agent: { id: "agent-other", revision: "1" },
          revision: "binding-v1",
        },
      },
    })).toThrow(/does not match the resolved child Agent/);
  });

  it("rejects duplicate Context material and Product-assigned source-result material", () => {
    const parent = material("parent_fact", "parent-fact", "mandatory");
    expect(() => createDelegationContextPlan({
      entries: [parent, parent],
      maxContextBytes: 8_192,
    })).toThrow(/must be unique/);

    expect(() => request({
      preparation: preparation({
        contextEntries: [
          parent,
          material("dependency_result", "result-old", "optional"),
        ],
      }),
    })).toThrow(/cannot assign trusted source-result Context material/);
  });

  it("rejects request content changed after revision construction", () => {
    const accepted = request();
    expect(() => snapshotDelegationRequest({
      ...accepted,
      objective: { ...accepted.objective, text: "replace the accepted objective" },
    })).toThrow(/revision does not match/);
  });

  it("rejects a Product request ceiling absent from the trusted limit derivation", () => {
    const widerRequest = createDelegationLimits({
      maxControllerTurns: 20,
      maxActions: 20,
      maxModelInputTokens: 20_000,
      maxModelOutputTokens: 5_000,
      maxCostUnits: 20_000,
      maxDurationMs: 60_000,
      maxContextBytes: 16_384,
      maxResultBytes: 65_536,
    });
    expect(() => request({
      preparation: preparation({ allocationRequest: widerRequest }),
    })).toThrow(/does not contain the exact allocation request/);
  });

  it("rejects Product authority constraints absent from the trusted derivation", () => {
    const authorityRestriction = authorityDimensions("delegation_restriction").map((dimension) =>
      dimension.kind === "tool"
        ? { ...dimension, allowed: ["tool:write"] }
        : dimension,
    );
    expect(() => request({
      preparation: preparation({ authorityRestriction }),
    })).toThrow(/restriction presence disagree/);
  });

  it("rejects a dependency result from another root Run", () => {
    expect(() => request({
      preparation: preparation({
        dependencyResult: { id: "result-old", revision: "result-old-v1" },
      }),
      dependencyResult: {
        correlation: {
          kind: "dependency",
          request: { id: "request-old", revision: "request-old-v1" },
          result: { id: "result-old", revision: "result-old-v1" },
          root: { id: "run-another-root" },
          child: {
            run: { id: "run-old-child" },
            task: { id: "task-old-child" },
            agent: CHILD_AGENT,
          },
        },
        material: createDelegationContextMaterial({
          owner: "agent-runtime",
          kind: "delegation_result",
          id: "result-old",
          payload: Object.freeze({ summary: "Earlier result" }),
        }),
      },
    })).toThrow(/same root Run/);
  });
});

describe("delegation result", () => {
  it("constructs trusted settlement while retaining narrative as attributed output", () => {
    const accepted = request();
    const result = createDelegationResult({
      resultId: "result-1",
      request: accepted,
      correlation: childCorrelation(accepted),
      childResult: createSucceededRunResult({
        runId: "run-child",
        taskId: "task-child",
        startingAgent: CHILD_AGENT,
        finalActiveAgent: CHILD_AGENT,
        startingInstructionBinding: childInstructionBinding("run-child"),
        finalInstructionBinding: childInstructionBinding("run-child"),
        startedAt: "2026-08-25T00:01:00.000Z",
        completedAt: "2026-08-25T00:02:00.000Z",
        evidenceRefs: ["evidence-1"],
        artifactRefs: ["artifact-1"],
      }, { summary: "child output" }),
      narrative: "Useful child findings.",
      verification: {
        status: "satisfied",
        snapshotRevision: "verification-v1",
        mandatoryTotal: 1,
        mandatorySatisfied: 1,
        limitationCodes: [],
      },
      effects: noEffects(),
      usage: usage(),
      limitDisposition: withinLimits(),
      createdAt: "2026-08-25T00:02:01.000Z",
    });

    expect(result.terminal).toEqual({
      status: "succeeded",
      code: null,
      failureKind: null,
      cancellationOrigin: null,
    });
    expect(result.narrative?.trust).toBe("attributed_model_output");
    expect(result.evidence.refs).toEqual(["evidence-1"]);
    expect(result.uncertainty).toEqual([
      "model_input_tokens_unavailable",
      "model_output_tokens_unavailable",
      "cost_units_unavailable",
    ]);
    expect(snapshotDelegationResult(result)).toEqual(result);
  });

  it("does not let useful narrative rewrite failed and uncertain child truth", () => {
    const accepted = request();
    const result = createDelegationResult({
      resultId: "result-failed",
      request: accepted,
      correlation: childCorrelation(accepted),
      childResult: createFailedRunResult(
        {
          runId: "run-child",
          taskId: "task-child",
          startingAgent: CHILD_AGENT,
          finalActiveAgent: CHILD_AGENT,
          startingInstructionBinding: childInstructionBinding("run-child"),
          finalInstructionBinding: childInstructionBinding("run-child"),
          startedAt: "2026-08-25T00:01:00.000Z",
          completedAt: "2026-08-25T00:02:00.000Z",
        },
        "runtime_execution_failed",
        createRunFailureCause("runtime", {
          code: "child_execution_failed",
          message: "The child failed after a possible effect.",
          retryable: false,
          metadata: {},
        }),
      ),
      narrative: "Some work may still be useful.",
      verification: {
        status: "unavailable",
        snapshotRevision: null,
        mandatoryTotal: 1,
        mandatorySatisfied: 0,
        limitationCodes: ["child_failed"],
      },
      effects: {
        status: "unknown",
        attempted: 1,
        settled: 0,
        uncertain: 1,
        settlementRefs: [],
      },
      usage: usage(),
      limitDisposition: withinLimits(),
      createdAt: "2026-08-25T00:02:01.000Z",
    });

    expect(result.terminal.status).toBe("failed");
    expect(result.terminal.failureKind).toBe("runtime");
    expect(result.narrative?.text).toContain("useful");
    expect(result.uncertainty).toContain("effects_unknown");
    expect(result.uncertainty).toContain("verification_unavailable");
    expect(result.expectationCoverage.find(({ form }) => form === "evidence")?.disposition)
      .toBe("failed");
  });

  it("rejects a result for another child and a forged immutable revision", () => {
    const accepted = request();
    expect(() => createDelegationResult({
      resultId: "result-wrong-child",
      request: accepted,
      correlation: childCorrelation(accepted),
      childResult: createSucceededRunResult({
        runId: "run-other",
        taskId: "task-child",
        startingAgent: CHILD_AGENT,
        finalActiveAgent: CHILD_AGENT,
        startingInstructionBinding: childInstructionBinding("run-other"),
        finalInstructionBinding: childInstructionBinding("run-other"),
        startedAt: "2026-08-25T00:01:00.000Z",
        completedAt: "2026-08-25T00:02:00.000Z",
      }, { summary: "done" }),
      narrative: null,
      verification: noVerification(),
      effects: noEffects(),
      usage: usage(),
      limitDisposition: withinLimits(),
      createdAt: "2026-08-25T00:02:01.000Z",
    })).toThrow(/does not match the delegation correlation/);
  });
});

describe("delegation steering route", () => {
  it("snapshots one exact active-child route without Permission meaning", () => {
    const accepted = request();
    const route = snapshotDelegationSteeringRoute({
      request: accepted.ref,
      relation: { id: "relation-1" },
      child: { id: "run-child" },
      steering: {
        commandId: "steering-1",
        expectedRunRevision: 3,
        instruction: "Focus on the requested child objective.",
        attribution: { origin: "user", actorId: "user-1" },
        submittedAt: "2026-08-25T00:01:30.000Z",
      },
    });

    expect(route.steering).not.toHaveProperty("approval");
    expect(route.child.id).toBe("run-child");
    expect(Object.isFrozen(route)).toBe(true);
  });
});

function request(overrides: {
  readonly toolCall?: ToolCall;
  readonly preparation?: DelegationPreparation;
  readonly dependencyResult?: Parameters<typeof materializeDelegationRequest>[0]["dependencyResult"];
  readonly replacedResult?: Parameters<typeof materializeDelegationRequest>[0]["replacedResult"];
} = {}) {
  return materializeDelegationRequest({
    requestId: "request-1",
    origin: origin(),
    toolCall: overrides.toolCall ?? toolCall(),
    preparation: overrides.preparation ?? preparation(),
    authorityDerivation: authorityDerivation(),
    limitDerivation: limitDerivation(),
    dependencyResult: overrides.dependencyResult ?? null,
    replacedResult: overrides.replacedResult ?? null,
    continuation: null,
    createdAt: "2026-08-25T00:00:10.000Z",
  });
}

function preparation(overrides: {
  readonly contextEntries?: readonly ReturnType<typeof material>[];
  readonly allocationRequest?: ReturnType<typeof limits>;
  readonly authorityRestriction?: readonly DelegationAuthorityDimensionInput[] | null;
  readonly dependencyResult?: DelegationPreparation["dependencyResult"];
  readonly replacedResult?: DelegationPreparation["replacedResult"];
} = {}): DelegationPreparation {
  return {
    schemaVersion: 1,
    childAgent: CHILD_AGENT,
    task: {
      kind: "helarc.delegated-task",
      input: { objective: "Inspect the requested files." },
      metadata: { source: "test" },
    },
    objective: {
      text: "Inspect the requested files and return bounded findings.",
      constraints: ["Do not modify files."],
    },
    expectedResult: createDelegationResultExpectation({
      requirements: [
        { form: "narrative", required: true, maxItems: 1 },
        { form: "evidence", required: false, maxItems: 8 },
        { form: "verification", required: false, maxItems: 1 },
        { form: "effects", required: true, maxItems: 1 },
      ],
      maxNarrativeCharacters: 8_192,
    }),
    contextPlan: createDelegationContextPlan({
      entries: overrides.contextEntries ?? [
        material("parent_fact", "parent-fact-1", "optional"),
      ],
      maxContextBytes: 16_384,
    }),
    authorityRestriction: overrides.authorityRestriction ?? null,
    allocationRequest: overrides.allocationRequest ?? limits(),
    dependencyResult: overrides.dependencyResult ?? null,
    replacedResult: overrides.replacedResult ?? null,
  };
}

function material(
  role: "parent_fact" | "dependency_result" | "replaced_result",
  id: string,
  necessity: "mandatory" | "optional",
) {
  return {
    role,
    material: {
      owner: "helarc",
      kind: role,
      id,
      revision: `${id}-v1`,
    },
    necessity,
  } as const;
}

function limits() {
  return createDelegationLimits({
    maxControllerTurns: 8,
    maxActions: 16,
    maxModelInputTokens: 8_000,
    maxModelOutputTokens: 2_000,
    maxCostUnits: 8_000,
    maxDurationMs: 60_000,
    maxContextBytes: 16_384,
    maxResultBytes: 65_536,
  });
}

function origin(): DelegationOriginCorrelation {
  return {
    root: { run: { id: "run-root" }, task: { id: "task-root" } },
    parent: {
      run: { id: "run-root" },
      task: { id: "task-root" },
      action: {
        run: { id: "run-root" },
        id: "action-1",
        sequence: 1,
      },
      lineage: { kind: "root", root: { id: "run-root" }, depth: 0 },
    },
  };
}

function toolCall(): ToolCall {
  return {
    toolCallId: "tool-call-1",
    parentRunAction: origin().parent.action,
    toolRevision: {
      tool: { namespace: "helarc", name: "agent" },
      revision: "tool-v1",
    },
    binding: {
      kind: "descendant_agent",
      agent: CHILD_AGENT,
      revision: "binding-v1",
    },
    selectionRevision: "selection-v1",
    exposureProofId: "exposure-proof-1",
    origin: "model",
    input: { prompt: "Inspect the requested files." },
    inputDigest: "sha256:tool-input",
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

function authorityDerivation() {
  return deriveDelegationAuthority({
    derivationId: "authority-1",
    sources: authoritySources(),
  });
}

function limitDerivation() {
  return deriveDelegationLimits({
    derivationId: "limit-derivation-1",
    sources: limitSources(),
  });
}

function limitSources(): readonly DelegationLimitSourceInput[] {
  const roles: readonly DelegationLimitSourceRole[] = [
    "root",
    "parent",
    "allocation_request",
    "current_policy",
  ];
  const turnCeilings = [12, 5, 8, 6];
  return roles.map((role, index) => ({
    role,
    ref: {
      owner: role,
      kind: "delegation_limits",
      id: `${role}-limits`,
      revision: `${role}-limits-v1`,
    },
    ceiling: createDelegationLimits({
      maxControllerTurns: turnCeilings[index]!,
      maxActions: 16,
      maxModelInputTokens: 8_000,
      maxModelOutputTokens: 2_000,
      maxCostUnits: 8_000,
      maxDurationMs: 60_000,
      maxContextBytes: 16_384,
      maxResultBytes: 65_536,
    }),
  }));
}

function authoritySources(): readonly DelegationAuthoritySourceInput[] {
  const roles: readonly DelegationAuthoritySourceRole[] = [
    "root",
    "parent",
    "current_policy",
  ];
  return roles.map((role, index) => ({
    role,
    ref: {
      owner: role,
      kind: "authority_profile",
      id: `${role}-authority`,
      revision: `${role}-v1`,
    },
    dimensions: authorityDimensions(role),
    deadlineAt: `2026-08-25T00:0${8 - index}:00.000Z`,
  }));
}

function authorityDimensions(
  role: DelegationAuthoritySourceRole,
): readonly DelegationAuthorityDimensionInput[] {
  const kinds = [
    "workspace",
    "tool",
    "permission",
    "action_execution",
    "sandbox",
    "verification",
    "disclosure",
    "resource",
  ] as const;
  return kinds.map((kind) => ({
    kind,
    allowed: kind === "tool" && role === "root"
      ? ["tool:read", "tool:write"]
      : kind === "tool"
        ? ["tool:read"]
        : [`${kind}:bounded`],
    required: kind === "verification" && ["root", "parent"].includes(role)
      ? [`verification:${role}`]
      : [],
  }));
}

function childCorrelation(accepted: ReturnType<typeof request>) {
  return {
    request: accepted.ref,
    origin: accepted.origin,
    relation: {
      ref: { id: "relation-1" },
      kind: "delegation",
      root: { id: "run-root" },
      parent: { id: "run-root" },
      child: { id: "run-child" },
      parentRunAction: accepted.origin.parent.action,
      depth: 1,
    },
    child: {
      run: { id: "run-child" },
      task: { id: "task-child" },
      agent: CHILD_AGENT,
    },
  } as const;
}

function childInstructionBinding(runId: string) {
  return Object.freeze({
    id: `${runId}:agent-instruction-binding:0`,
    revision: `sha256:${"0".repeat(64)}`,
  });
}

function usage() {
  return {
    controllerTurns: { status: "measured", value: 2 },
    actions: { status: "measured", value: 1 },
    modelInputTokens: { status: "unavailable", reason: "provider_omitted" },
    modelOutputTokens: { status: "unavailable", reason: "provider_omitted" },
    costUnits: { status: "unavailable", reason: "not_metered" },
  } as const;
}

function withinLimits() {
  return {
    status: "within_limits",
    exhaustedLimit: null,
    controllerTurns: 2,
    actions: 1,
    durationMs: 60_000,
    contextBytes: 4_096,
    resultBytes: 2_048,
  } as const;
}

function noEffects() {
  return {
    status: "none",
    attempted: 0,
    settled: 0,
    uncertain: 0,
    settlementRefs: [],
  } as const;
}

function noVerification() {
  return {
    status: "not_required",
    snapshotRevision: null,
    mandatoryTotal: 0,
    mandatorySatisfied: 0,
    limitationCodes: [],
  } as const;
}
