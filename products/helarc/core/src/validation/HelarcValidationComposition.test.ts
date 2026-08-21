import type { RunRef } from "@agent-anything/agent-core/run";
import { createOperationResult } from "@agent-anything/operation-catalog/result";
import {
  materializeValidationProfile,
  type ValidationOwnerRef,
} from "@agent-anything/validation/definition";
import type {
  ValidationExecutionPort,
  ValidationOperationCheckResolverPort,
} from "@agent-anything/validation/execution";
import type { CodeSourcePort, CodeSourceSnapshot } from "@agent-anything/helarc-code-agent/source";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { describe, expect, it } from "vitest";
import {
  createHelarcValidationComposition,
  type HelarcValidationComposition,
} from "./HelarcValidationComposition.js";
import {
  HELARC_RUN_VALIDATION_CHECK_OPERATION,
} from "./HelarcValidationCheckOperation.js";

const NOW = "2026-08-18T00:00:00.000Z";
const RUN: RunRef = Object.freeze({ id: "run-1" });

describe("Helarc Validation composition", () => {
  it("materializes the single Code Agent profile with command Validation", async () => {
    const source = mutableCodeSource(absentSnapshot());
    const composition = await createComposition(source.port);
    const execution = await prepare(composition);

    expect(composition.profile.requirements).toHaveLength(1);
    expect(composition.operation).not.toBeNull();
    expect((await execution.readCurrentSnapshot()).requirementStates)
      .toEqual([expect.objectContaining({ status: "unassessed" })]);
  });

  it("assesses exact target state as satisfied without creating effectful work", async () => {
    const source = mutableCodeSource(absentSnapshot());
    const composition = await createComposition(source.port, exactTarget());
    const execution = await prepare(composition);

    expect((await execution.readCurrentSnapshot()).requirementStates)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        requirement: expect.objectContaining({ id: "target-empty-marker" }), status: "satisfied",
      })]));
    expect((await execution.readHistory()).filter(({ kind }) => kind === "check_attempt"))
      .toHaveLength(1);
  });

  it("assesses a mismatched exact target as violated and later marks a changed subject stale", async () => {
    const source = mutableCodeSource(presentSnapshot("sha256:current"));
    const composition = await createComposition(source.port, exactTarget());
    const execution = await prepare(composition);
    const assessed = await execution.readCurrentSnapshot();

    const targetState = assessed.requirementStates.find(({ requirement }) => requirement.id === "target-empty-marker");
    expect(targetState).toMatchObject({ status: "violated" });
    source.set(absentSnapshot("2026-08-18T00:00:01.000Z"));
    const subject = targetState?.subject;
    if (subject === null || subject === undefined) throw new Error("Expected an exact target subject.");
    await execution.checkSubjectFreshness({
      requirement: targetState!.requirement,
      snapshot: subject,
      expectedRevision: assessed.ref.revision,
    }, liveInterruption());

    expect((await execution.readCurrentSnapshot()).requirementStates.find(({ requirement }) => requirement.id === "target-empty-marker"))
      .toMatchObject({ status: "stale" });
  });

  it.each([
    { exitCode: 0, expected: "satisfied" },
    { exitCode: 1, expected: "violated" },
  ] as const)("assesses command exit $exitCode as $expected", async ({ exitCode, expected }) => {
    const source = mutableCodeSource(absentSnapshot());
    const composition = await createComposition(source.port);
    const execution = await prepare(composition, commandSettlement(exitCode));
    const resolver = composition.runner.checkRequests;
    const processor = composition.runner.checkResults;
    if (resolver === undefined || processor === undefined) {
      throw new Error("Shell-enabled profile must expose command Check adapters.");
    }
    const runAction = Object.freeze({ run: RUN, id: "run-action-1", sequence: 1 });
    const request = await resolver.resolve({
      run: RUN,
      runAction,
      operation: HELARC_RUN_VALIDATION_CHECK_OPERATION,
      request: validationCommandRequest(),
      requestOrigin: "tool_request",
    });
    if (request === null) throw new Error("Expected a Validation Check request.");
    const current = await execution.readCurrentSnapshot();
    const result = await execution.executeCheck({
      ...request,
      origin: "controller",
      runAction,
      expectedRevision: current.ref.revision,
    }, liveInterruption());
    await processor.process({ run: RUN, execution, request, result }, liveInterruption());

    expect(result.status).toBe("completed");
    expect((await execution.readCurrentSnapshot()).requirementStates[0])
      .toMatchObject({ status: expected });
  });
});

async function createComposition(
  codeSource: CodeSourcePort,
  target?: ReturnType<typeof exactTarget>,
): Promise<HelarcValidationComposition> {
  return createHelarcValidationComposition({
    workspace: WORKSPACE,
    codeSource,
    commandEnvironment: Object.freeze({ id: "command-environment", revision: "sha256:environment" }),
    exactTargets: target === undefined ? [] : [target],
    admittedAt: NOW,
    now: () => NOW,
  });
}

async function prepare(
  composition: HelarcValidationComposition,
  operationChecks: ValidationOperationCheckResolverPort = Object.freeze({ resolve: () => null }),
): Promise<ValidationExecutionPort> {
  const execution = await composition.runner.executionFactory.create({ run: RUN, operationChecks });
  const materialized = materializeValidationProfile({ profile: composition.profile, run: RUN, createdAt: NOW });
  await execution.admitSpecification({
    specification: materialized.specification,
    requirements: materialized.requirements,
    expectedRevision: 0,
  }, liveInterruption());
  await composition.runner.preparation?.prepare({
    run: RUN,
    execution,
    automaticEffectfulChecks: Object.freeze({
      async execute() {
        throw new Error("This profile test does not dispatch automatic effectful Checks.");
      },
    }),
  }, liveInterruption());
  return execution;
}

function commandSettlement(exitCode: number): ValidationOperationCheckResolverPort {
  return Object.freeze({
    resolve: () => Object.freeze({
      async requestSettlement(input) {
        const invocation = Object.freeze({
          id: "validation-operation-invocation-1",
          operation: HELARC_RUN_VALIDATION_CHECK_OPERATION,
        });
        return Object.freeze({
          operationInvocation: invocation,
          operationResult: createOperationResult({
            ref: { invocation, id: "validation-operation-result-1" },
            binding: { operation: invocation.operation, revision: "1" },
            semanticOwner: "helarc",
            status: "succeeded",
            output: {
              claim: "tests",
              childOperationResultId: "command-operation-result-1",
              command: {
                exitCode,
                signal: null,
                durationMs: 10,
                stdoutTruncated: false,
                stderrTruncated: false,
                settlementConfirmed: true,
              },
            },
            failure: null,
            startedAt: NOW,
            finishedAt: NOW,
            lowerRefs: [],
            metadata: {},
          }),
          actionSettlement: Object.freeze({ action: { id: input.attempt.runAction!.id }, id: "settlement-1" }),
          effectCertainty: "confirmed" as const,
          costUnits: 1,
        });
      },
    }),
  });
}

function validationCommandRequest() {
  return Object.freeze({
    claim: "tests",
    command: "pnpm test",
    timeout_ms: 30_000,
    description: "Verify the current workspace.",
  });
}

function exactTarget() {
  return Object.freeze({
    target: Object.freeze({
      ref: Object.freeze({
        owner: "helarc.code-workspace",
        kind: "target_state",
        id: "empty-marker",
        revision: "1",
      }),
      expected: absentSnapshot(),
      maxContentBytes: 1_024,
    }),
    necessity: "mandatory" as const,
    claim: "The marker file is absent.",
    purpose: "Verify the exact requested target state.",
  });
}

function mutableCodeSource(initial: CodeSourceSnapshot) {
  let current = initial;
  return {
    port: Object.freeze({
      async capture() {
        return Object.freeze({ status: "captured" as const, snapshot: current });
      },
      async rehydrate(input) {
        return JSON.stringify(input.expected.baseline) === JSON.stringify(current.baseline)
          ? Object.freeze({ status: "matched" as const, snapshot: current })
          : Object.freeze({
              status: "changed" as const,
              snapshot: current,
              owner: "helarc.code-workspace" as const,
              code: "code_source_changed",
              message: "Code source changed.",
            });
      },
    } satisfies CodeSourcePort),
    set(snapshot: CodeSourceSnapshot) {
      current = snapshot;
    },
  };
}

function absentSnapshot(capturedAt = NOW): CodeSourceSnapshot {
  return Object.freeze({
    target: Object.freeze({ rootName: "primary", workspaceId: "workspace", path: "empty.txt" }),
    baseline: Object.freeze({ kind: "absent" as const }),
    content: null,
    contentRef: null,
    capturedAt,
  });
}

function presentSnapshot(contentDigest: string): CodeSourceSnapshot {
  return Object.freeze({
    target: Object.freeze({ rootName: "primary", workspaceId: "workspace", path: "empty.txt" }),
    baseline: Object.freeze({
      kind: "present" as const,
      entryKind: "file" as const,
      objectIdentity: Object.freeze({ kind: "posix" as const, deviceId: "1", inode: "1" }),
      contentDigest,
    }),
    content: "current",
    contentRef: Object.freeze({ algorithm: "sha256" as const, digest: contentDigest, byteLength: 7 }),
    capturedAt: NOW,
  });
}

function liveInterruption() {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}

function owner(id: string, kind: string): ValidationOwnerRef {
  return Object.freeze({ owner: "helarc.test", kind, id, revision: "1" });
}

const WORKSPACE: WorkspaceSelection = Object.freeze({
  primary: Object.freeze({
    id: "workspace",
    name: "Workspace",
    rootRef: "workspace:primary",
    trustState: "trusted",
    source: "test",
    policyRefs: Object.freeze([]),
    metadata: Object.freeze({}),
  }),
  additional: Object.freeze([]),
});
