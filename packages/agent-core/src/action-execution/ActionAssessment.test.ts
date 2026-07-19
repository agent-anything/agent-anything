import { describe, expect, it, vi } from "vitest";
import type { ActionPolicyPort, ManagedPermissionConstraints } from "@agent-anything/governance";
import {
  createApprovalRequest,
  resolvePermissionProfile,
  type ActionApprovalCoverage,
} from "@agent-anything/permission";
import type { Action } from "../action/index.js";
import type { ActionAdapter, ActionAdapterPreparedData } from "./ActionAdapter.js";
import type { ActionAssessmentAuthoritySnapshot } from "./ActionAssessment.js";
import { ActionEnforcementPipeline } from "./ActionEnforcementPipeline.js";
import { createActionRegistrationSnapshot } from "./ActionRegistration.js";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;
const NOW = "2026-07-16T00:00:00.000Z";
const DEADLINE = "2026-07-16T01:00:00.000Z";

describe("fixed-order Action assessment", () => {
  it("short-circuits managed denial before Governance Policy", async () => {
    const evaluate = vi.fn<ActionPolicyPort["evaluate"]>();
    const pipeline = createPipeline(networkData(), { evaluate });
    const prepared = await prepare(pipeline);
    const result = await pipeline.assess(assessmentInput(prepared, {
      managedConstraints: constraints({ network: { enabled: false, allowedDomains: [], deniedDomains: [] } }),
    }));

    expect(result).toEqual(expect.objectContaining({
      status: "denied",
      owner: "permission",
      code: "permission_managed_network_denied",
    }));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps Governance denial and forbidden Rules non-reviewable", async () => {
    const deniedPipeline = createPipeline(processData(), policy("denied"));
    const deniedPrepared = await prepare(deniedPipeline);
    expect(await deniedPipeline.assess(assessmentInput(deniedPrepared))).toEqual(
      expect.objectContaining({ status: "denied", owner: "policy", code: "policy_denied" }),
    );

    const forbiddenPipeline = createPipeline(processData(), policy("allowed"));
    const forbiddenPrepared = await prepare(forbiddenPipeline);
    const forbidden = await forbiddenPipeline.assess(assessmentInput(forbiddenPrepared, {
      execRules: [execRule("allow", "allow"), execRule("prompt", "prompt"), execRule("deny", "forbidden")],
    }));
    expect(forbidden).toEqual(expect.objectContaining({
      status: "denied",
      owner: "policy",
      code: "policy_rule_forbidden",
    }));
  });

  it("converges policy review, rule prompt, and missing authority into one requirement", async () => {
    const pipeline = createPipeline(processData(), policy("requires_review"));
    const prepared = await prepare(pipeline);
    const result = await pipeline.assess(assessmentInput(prepared, {
      execRules: [execRule("prompt", "prompt")],
    }));

    expect(result.status).toBe("approval_required");
    if (result.status !== "approval_required") return;
    expect(result.requirement.category).toBe("commandExecution");
    expect(result.requirement.metadata).toEqual({
      causes: ["governance_review", "rule_prompt", "missing_authority"],
    });
    expect(result.requirement.decisionOptions.filter(({ kind }) => kind === "decline")).toHaveLength(1);
    expect(() => createApprovalRequest({
      id: "approval-1",
      createdAt: NOW,
      requirement: result.requirement,
    })).not.toThrow();
  });

  it("denies reviewable authority when ApprovalPolicy cannot request it", async () => {
    const pipeline = createPipeline(processData(), policy("allowed"));
    const prepared = await prepare(pipeline);
    const result = await pipeline.assess(assessmentInput(prepared, { approvalPolicy: "never" }));
    expect(result).toEqual(expect.objectContaining({
      status: "denied",
      owner: "permission",
      code: "permission_approval_not_allowed",
    }));
  });

  it("maps an effect-free canonical Skill only when Governance requires its trusted review mapping", async () => {
    const pipeline = createPipeline(skillData(), policy("requires_review"));
    const prepared = await prepare(pipeline);
    const result = await pipeline.assess(assessmentInput(prepared));

    expect(result.status).toBe("approval_required");
    if (result.status !== "approval_required") return;
    expect(result.requirement.category).toBe("skill");
    expect(result.requirement.metadata).toEqual({ causes: ["governance_review"] });
    expect(result.requirement.decisionOptions.some(({ kind }) => kind === "grantPermissions")).toBe(false);
  });

  it("uses exact Action coverage to satisfy review and emits a consumption-bound authorization", async () => {
    const pipeline = createPipeline(processData(), policy("requires_review"));
    const prepared = await prepare(pipeline);
    const coverage: ActionApprovalCoverage = {
      id: "coverage-1",
      runId: prepared.action.runId,
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      sourceRequestId: "approval-1",
      grantedPermissions: null,
      status: "available",
      createdAt: NOW,
    };
    const result = await pipeline.assess(assessmentInput(prepared, {
      execRules: [execRule("prompt", "prompt")],
      actionCoverage: [coverage],
    }));

    expect(result.status).toBe("authorized");
    if (result.status !== "authorized") return;
    expect(result.authorization.actionCoverageIdToConsume).toBe("coverage-1");
    expect(result.authorization.authoritySources).toContainEqual({
      kind: "action_coverage",
      id: "coverage-1",
    });
    expect(result.authorization.effectivePermissions.process.spawn.kind).toBe("restricted");
  });

  it("assesses one immutable authority snapshot across asynchronous Policy evaluation", async () => {
    const coverages: ActionApprovalCoverage[] = [];
    const policyPort: ActionPolicyPort = {
      async evaluate(input) {
        coverages.splice(0, coverages.length);
        return { checkId: input.checkId, status: "allowed", decidedAt: NOW };
      },
    };
    const pipeline = createPipeline(processData(), policyPort);
    const prepared = await prepare(pipeline);
    coverages.push({
      id: "coverage-snapshot",
      runId: prepared.action.runId,
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      sourceRequestId: "approval-snapshot",
      grantedPermissions: null,
      status: "available",
      createdAt: NOW,
    });
    const input = assessmentInput(prepared, { actionCoverage: coverages });
    const result = await pipeline.assess(input);

    expect(coverages).toEqual([]);
    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.actionCoverageIdToConsume).toBe("coverage-snapshot");
    }
  });

  it("rejects a weaker approval category instead of sending it to review", async () => {
    const data = processData();
    const pipeline = createPipeline({
      ...data,
      approvalCategory: "networkAccess",
      approvalPayload: {
        host: "example.com",
        port: 443,
        protocol: "https",
        actionSummary: "Connect",
      },
      applicabilityKeys: [{ category: "networkAccess", value: "example.com:443" }],
    }, policy("allowed"));
    const prepared = await prepare(pipeline);
    expect(await pipeline.assess(assessmentInput(prepared))).toEqual(expect.objectContaining({
      status: "denied",
      owner: "tool",
      code: "action_review_category_unsupported",
    }));
  });

  it("returns closed invalidated, failed, and interrupted assessment outcomes", async () => {
    const pipeline = createPipeline(processData(), policy("allowed"));
    const prepared = await prepare(pipeline);
    const base = assessmentInput(prepared);
    const invalidated = await pipeline.assess({
      ...base,
      authority: {
        ...base.authority,
        profile: { ...base.authority.profile, environmentId: "other-environment" },
      },
    });

    const failingPipeline = createPipeline(processData(), {
      async evaluate() { throw new Error("unavailable"); },
    });
    const failedPrepared = await prepare(failingPipeline);
    const failed = await failingPipeline.assess(assessmentInput(failedPrepared));

    const controller = new AbortController();
    controller.abort();
    const interrupted = await pipeline.assess({
      ...base,
      interruption: {
        signal: controller.signal,
        interruption: {
          kind: "run_cancellation",
          cancellation: { runId: "run-1", requestId: "cancel-1" },
        },
      },
    });

    expect(invalidated).toEqual(expect.objectContaining({
      status: "invalidated",
      code: "permission_assessment_context_mismatch",
    }));
    expect(failed).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ owner: "policy", code: "policy_evaluation_failed" }),
    }));
    expect(interrupted).toEqual({
      status: "interrupted",
      interruption: {
        kind: "run_cancellation",
        cancellation: { runId: "run-1", requestId: "cancel-1" },
      },
    });
  });

  it("repeats Policy assessment before target revalidation and creates an immutable dispatch plan", async () => {
    let policyCalls = 0;
    let targetCalls = 0;
    const pipeline = createPipeline(skillData(), {
      async evaluate(input) {
        policyCalls += 1;
        return { checkId: input.checkId, status: "allowed", decidedAt: NOW };
      },
    }, async () => {
      targetCalls += 1;
      return { status: "valid" };
    });
    const prepared = await prepare(pipeline);
    const input = assessmentInput(prepared);
    const assessment = await pipeline.assess(input);
    expect(assessment.status).toBe("authorized");
    if (assessment.status !== "authorized") return;

    const revalidation = await pipeline.revalidate({
      prepared,
      authorization: assessment.authorization,
      authority: input.authority,
      interruption: interruption(),
      attemptOrdinal: 1,
    });

    expect(revalidation.status).toBe("ready");
    if (revalidation.status !== "ready") return;
    expect(policyCalls).toBe(2);
    expect(targetCalls).toBe(1);
    expect(revalidation.plan).toMatchObject({
      runId: prepared.action.runId,
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      preparedInvocationDigest: prepared.subject.preparedInvocationDigest,
      enforcement: "managed",
      attemptOrdinal: 1,
    });
    expect(revalidation.plan.dispatchPlanFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(revalidation.plan)).toBe(true);

    const copiedAuthorization = Object.freeze({
      ...assessment.authorization,
      actionId: "substituted-action",
    });
    expect(await pipeline.revalidate({
      prepared,
      authorization: copiedAuthorization,
      authority: input.authority,
      interruption: interruption(),
      attemptOrdinal: 1,
    })).toEqual(expect.objectContaining({
      status: "invalidated",
      code: "action_revalidation_authorization_invalid",
    }));
  });

  it("returns changed Policy and stale target results without creating a dispatch plan", async () => {
    let policyCalls = 0;
    let targetCalls = 0;
    const changedPolicyPipeline = createPipeline(skillData(), {
      async evaluate(input) {
        policyCalls += 1;
        return {
          checkId: input.checkId,
          status: policyCalls === 1 ? "allowed" : "denied",
          ...(policyCalls === 1 ? {} : { code: "policy_changed" }),
          decidedAt: NOW,
        };
      },
    }, async () => {
      targetCalls += 1;
      return { status: "valid" };
    });
    const changedPrepared = await prepare(changedPolicyPipeline);
    const changedInput = assessmentInput(changedPrepared);
    const changedAssessment = await changedPolicyPipeline.assess(changedInput);
    if (changedAssessment.status !== "authorized") throw new Error("Expected authorization.");
    expect(await changedPolicyPipeline.revalidate({
      prepared: changedPrepared,
      authorization: changedAssessment.authorization,
      authority: changedInput.authority,
      interruption: interruption(),
      attemptOrdinal: 1,
    })).toEqual(expect.objectContaining({
      status: "denied",
      owner: "policy",
      code: "policy_changed",
    }));
    expect(targetCalls).toBe(0);

    const stalePipeline = createPipeline(skillData(), policy("allowed"), async () => {
      return {
        status: "invalidated",
        code: "tool_target_baseline_changed",
        message: "The target baseline changed.",
      };
    });
    const stalePrepared = await prepare(stalePipeline);
    const staleInput = assessmentInput(stalePrepared);
    const staleAssessment = await stalePipeline.assess(staleInput);
    if (staleAssessment.status !== "authorized") throw new Error("Expected authorization.");
    expect(await stalePipeline.revalidate({
      prepared: stalePrepared,
      authorization: staleAssessment.authorization,
      authority: staleInput.authority,
      interruption: interruption(),
      attemptOrdinal: 1,
    })).toEqual({
      status: "invalidated",
      code: "tool_target_baseline_changed",
      message: "The target baseline changed.",
    });

    const replacementPipeline = createPipeline(
      skillData(),
      policy("allowed"),
      async () => ({ status: "valid" }),
      "2",
    );
    expect(await replacementPipeline.revalidate({
      prepared: stalePrepared,
      authorization: staleAssessment.authorization,
      authority: staleInput.authority,
      interruption: interruption(),
      attemptOrdinal: 1,
    })).toEqual({
      status: "invalidated",
      code: "action_registration_changed",
      message: "The Action registration no longer matches the prepared subject.",
    });
  });

  it("requires approval again when exact Action coverage disappears before final revalidation", async () => {
    let targetCalls = 0;
    const pipeline = createPipeline(processData(), policy("allowed"), async () => {
      targetCalls += 1;
      return { status: "valid" };
    });
    const prepared = await prepare(pipeline);
    const coverage: ActionApprovalCoverage = {
      id: "coverage-final",
      runId: prepared.action.runId,
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      sourceRequestId: "approval-final",
      grantedPermissions: null,
      status: "available",
      createdAt: NOW,
    };
    const initialInput = assessmentInput(prepared, { actionCoverage: [coverage] });
    const initial = await pipeline.assess(initialInput);
    if (initial.status !== "authorized") throw new Error("Expected authorization.");

    const result = await pipeline.revalidate({
      prepared,
      authorization: initial.authorization,
      authority: { ...initialInput.authority, actionCoverage: [] },
      interruption: interruption(),
      attemptOrdinal: 1,
    });

    expect(result.status).toBe("approval_required");
    if (result.status === "approval_required") {
      expect(result.requirement.metadata).toEqual({ causes: ["missing_authority"] });
    }
    expect(targetCalls).toBe(0);
  });
});

function createPipeline(
  data: ActionAdapterPreparedData,
  actionPolicy: ActionPolicyPort,
  revalidate: ActionAdapter["revalidate"] = async () => ({ status: "valid" }),
  adapterVersion = "1",
) {
  const descriptor = { id: "test.adapter", version: adapterVersion, inputSchemaVersion: "1" };
  const executor = { id: "test.executor", version: "1", invocationContractVersion: "1" };
  return new ActionEnforcementPipeline({
    registrations: createActionRegistrationSnapshot([{
      actionName: "test.action",
      adapter: descriptor,
      executor,
    }]),
    adapters: [{
      actionName: "test.action",
      adapter: {
        descriptor,
        async prepare() { return { status: "prepared" as const, data }; },
        revalidate,
      },
    }],
    policyPort: actionPolicy,
    now: () => NOW,
  });
}

function policy(status: "allowed" | "denied" | "requires_review"): ActionPolicyPort {
  return {
    async evaluate(input) {
      return {
        checkId: input.checkId,
        status,
        ...(status === "denied" ? { code: "policy_denied" as const } : {}),
        decidedAt: NOW,
      };
    },
  };
}

async function prepare(pipeline: ActionEnforcementPipeline) {
  const result = await pipeline.prepare({
    action: action(),
    workspace: {
      workspaceId: "workspace-1",
      trustState: "trusted",
      roots: [{
        rootId: "root-1",
        platform: "win32",
        path: "D:/workspace",
        resolvedPath: "D:/workspace",
        resolutionFingerprint: SHA_A,
      }],
    },
    actor: { identityId: "user-1", kind: "user" },
    environment: { environmentId: "local", platform: "win32", configurationFingerprint: SHA_B },
    interruption: interruption(),
  });
  if (result.status !== "prepared") throw new Error(`Preparation failed: ${result.status}`);
  return result.prepared;
}

function assessmentInput(
  prepared: Awaited<ReturnType<typeof prepare>>,
  overrides: Partial<ActionAssessmentAuthoritySnapshot> = {},
) {
  const managed = overrides.managedConstraints ?? constraints();
  const profile = overrides.profile ?? resolvePermissionProfile({
    profileId: ":read-only",
    profiles: [],
    environment: {
      environmentId: "local",
      platform: "win32",
      workspaceRoots: [{ rootId: "root-1", path: "D:/workspace" }],
    },
    managedConstraints: managed,
  });
  return {
    prepared,
    authority: {
      profile,
      approvalPolicy: "on-request" as const,
      managedConstraints: managed,
      execRules: [],
      networkRules: [],
      runPermissionGrants: [],
      sessionAuthorityContext: null,
      sessionAuthorityRecords: [],
      appliedPolicyAmendments: [],
      actionCoverage: [],
      approvalDeadlineAt: DEADLINE,
      ...overrides,
    },
    interruption: interruption(),
  };
}

function processData(): ActionAdapterPreparedData {
  const executable = {
    path: path("D:/bin/tool.exe", null),
    baseline: {
      kind: "present" as const,
      entryKind: "file" as const,
      objectIdentity: { kind: "win32" as const, volumeId: "volume-1", fileId: "tool-1" },
      contentDigest: SHA_C,
    },
  };
  return {
    operation: {
      kind: "process",
      operation: "spawn",
      executable,
      arguments: [{ kind: "literal", value: "status" }],
      cwd: path("D:/workspace", "root-1"),
      environmentDigest: SHA_A,
    },
    effectSet: { kind: "effects", values: [{ kind: "process", operation: "spawn", executable }] },
    requestedPermissions: null,
    targetAssertions: [],
    approvalCategory: "commandExecution",
    approvalPayload: {
      command: ["D:/bin/tool.exe", "status"],
      safeCommandDisplay: "tool status",
      cwd: "D:/workspace",
      cwdDisplay: "workspace",
      environmentId: "local",
      commandActions: [{ kind: "process", summary: "Run tool status" }],
      additionalPermissions: null,
    },
    applicabilityKeys: [{ category: "commandExecution", value: "D:/bin/tool.exe:status" }],
    safeSummary: { kind: "process", headline: "Run status", commandDisplay: "tool status", cwdDisplay: "workspace" },
    preparedInvocation: { contractVersion: "1", executorId: "test.executor", executorVersion: "1", payload: {} },
  };
}

function networkData(): ActionAdapterPreparedData {
  const endpoint = { transport: "tcp" as const, host: "api.example.com", port: 443, applicationProtocol: "https" };
  return {
    operation: { kind: "network", operation: "request", method: "GET", endpoint, requestDigest: SHA_A },
    effectSet: { kind: "effects", values: [{ kind: "network", operation: "connect", endpoints: [endpoint] }] },
    requestedPermissions: { network: { enabled: true, domains: ["api.example.com"] } },
    targetAssertions: [],
    approvalCategory: "networkAccess",
    approvalPayload: { host: "api.example.com", port: 443, protocol: "https", actionSummary: "Call API" },
    applicabilityKeys: [{ category: "networkAccess", value: "api.example.com:443" }],
    safeSummary: { kind: "network", headline: "Call API", endpointDisplay: "api.example.com" },
    preparedInvocation: { contractVersion: "1", executorId: "test.executor", executorVersion: "1", payload: {} },
  };
}

function skillData(): ActionAdapterPreparedData {
  return {
    operation: {
      kind: "skill",
      operation: "invoke",
      skillId: "skill.review",
      skillVersion: "1",
      sourceFingerprint: SHA_B,
      action: "review workspace",
      argumentsDigest: SHA_A,
    },
    effectSet: { kind: "effect_free" },
    requestedPermissions: null,
    targetAssertions: [],
    approvalCategory: "skill",
    approvalPayload: {
      skillId: "skill.review",
      skillDisplayName: "Review workspace",
      action: "review workspace",
      requiredPermissions: null,
    },
    applicabilityKeys: [{ category: "skill", value: "skill.review:1" }],
    safeSummary: { kind: "computation", headline: "Load review skill" },
    preparedInvocation: { contractVersion: "1", executorId: "test.executor", executorVersion: "1", payload: {} },
  };
}

function action(): Action {
  return {
    id: "action-1",
    runId: "run-1",
    sequence: 1,
    kind: "tool",
    name: "test.action",
    input: {},
    provenance: { modelItemId: "item-1", controllerIteration: 1 },
  };
}

function execRule(id: string, decision: "allow" | "prompt" | "forbidden") {
  return {
    id,
    commandPattern: ["D:/bin/tool.exe"] as [string, ...string[]],
    cwd: "D:/workspace",
    decision,
    source: "test",
    justification: null,
  };
}

function constraints(
  overrides: Partial<ManagedPermissionConstraints> = {},
): ManagedPermissionConstraints {
  return {
    constraintSetId: "managed-1",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
    ...overrides,
  };
}

function path(value: string, workspaceRootId: string | null) {
  return {
    platform: "win32" as const,
    path: value,
    resolvedPath: value,
    workspaceRootId,
    resolutionFingerprint: SHA_A,
  };
}

function interruption() {
  const controller = new AbortController();
  return { signal: controller.signal, interruption: null };
}
