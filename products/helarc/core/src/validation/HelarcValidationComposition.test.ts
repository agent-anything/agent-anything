import type { RunRef } from "@agent-anything/agent-core/run";
import { createOperationResult } from "@agent-anything/operation-catalog/result";
import {
  materializeValidationProfile,
  type ValidationOwnerRef,
} from "@agent-anything/validation/definition";
import type {
  ValidationExecutionPort,
  ValidationLowerCheckSettlement,
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
  bindingRefForCodeFileTool,
  operationRefForCodeFileTool,
} from "@agent-anything/helarc-code-agent/file-operation";
import {
  HELARC_SHELL_BINDING,
  HELARC_SHELL_OPERATION,
} from "../tools/HelarcCommandOperation.js";

const NOW = "2026-08-18T00:00:00.000Z";
const RUN: RunRef = Object.freeze({ id: "run-1" });

describe("Helarc Validation composition", () => {
  it("materializes the single Code Agent profile with command Validation", async () => {
    const source = mutableCodeSource(absentSnapshot());
    const composition = await createComposition(source.port);
    const execution = await prepare(composition);

    expect(composition.profile.requirements).toHaveLength(1);
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
    const execution = await prepare(composition);
    const processor = composition.runner.settledOperationResults;
    if (processor === null) throw new Error("Shell-enabled profile must interpret settled commands.");
    const runAction = Object.freeze({ run: RUN, id: "run-action-1", sequence: 1 });
    await processor.process({
      run: RUN,
      execution,
      runAction,
      operation: HELARC_SHELL_OPERATION,
      request: shellCommandRequest(),
      requestOrigin: "tool_request",
      settlement: commandSettlement(exitCode, runAction.id, "1"),
    }, liveInterruption());

    expect((await execution.readHistory()).filter(({ kind }) => kind === "check_result"))
      .toHaveLength(1);
    expect((await execution.readCurrentSnapshot()).requirementStates[0])
      .toMatchObject({ status: expected });
  });

  it("replaces failed command feedback with a later current successful Assessment", async () => {
    const composition = await createComposition(mutableCodeSource(absentSnapshot()).port);
    const execution = await prepare(composition);
    const processor = composition.runner.settledOperationResults;
    if (processor === null) throw new Error("Expected settled command Validation processing.");

    for (const [sequence, exitCode] of [[1, 1], [2, 0]] as const) {
      const runAction = Object.freeze({
        run: RUN,
        id: `run-action-${sequence}`,
        sequence,
      });
      await processor.process({
        run: RUN,
        execution,
        runAction,
        operation: HELARC_SHELL_OPERATION,
        request: shellCommandRequest(),
        requestOrigin: "tool_request",
        settlement: commandSettlement(exitCode, runAction.id, String(sequence)),
      }, liveInterruption());
    }

    expect((await execution.readCurrentSnapshot()).requirementStates[0])
      .toMatchObject({ status: "satisfied" });
    expect((await execution.readHistory()).filter(({ kind }) => kind === "check_result"))
      .toHaveLength(2);
  });

  it("revalidates an admitted exact target after an ordinary Write settlement", async () => {
    const source = mutableCodeSource(absentSnapshot());
    const composition = await createComposition(source.port, exactTarget());
    const execution = await prepare(composition);
    const processor = composition.runner.settledOperationResults;
    if (processor === null) throw new Error("Expected exact target settlement processing.");
    source.set(presentSnapshot("sha256:changed"));

    await processor.process({
      run: RUN,
      execution,
      runAction: Object.freeze({ run: RUN, id: "run-action-write", sequence: 1 }),
      operation: operationRefForCodeFileTool("Write"),
      request: Object.freeze({ file_path: "./empty.txt", content: "current" }),
      requestOrigin: "tool_request",
      settlement: fileSettlement("Write"),
    }, liveInterruption());

    expect((await execution.readCurrentSnapshot()).requirementStates.find(
      ({ requirement }) => requirement.id === "target-empty-marker",
    )).toMatchObject({ status: "violated" });
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

function commandSettlement(
  exitCode: number,
  runActionId: string,
  suffix: string,
): ValidationLowerCheckSettlement {
  const invocation = Object.freeze({
    id: `command-operation-invocation-${suffix}`,
    operation: HELARC_SHELL_OPERATION,
  });
  return Object.freeze({
    operationInvocation: invocation,
    operationResult: createOperationResult({
      ref: { invocation, id: `command-operation-result-${suffix}` },
      binding: HELARC_SHELL_BINDING,
      semanticOwner: "helarc",
      status: "succeeded",
      output: {
        mode: "foreground",
        exit_code: exitCode,
        signal: null,
        duration_ms: 10,
        stdout: "",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        stdout_overflow_file: null,
        stderr_overflow_file: null,
      },
      failure: null,
      startedAt: NOW,
      finishedAt: NOW,
      lowerRefs: [],
      metadata: {},
    }),
    actionSettlement: Object.freeze({
      action: { id: runActionId },
      id: `settlement-${suffix}`,
    }),
    effectCertainty: "confirmed",
    costUnits: 1,
  });
}

function fileSettlement(
  tool: "Read" | "Edit" | "Write",
): ValidationLowerCheckSettlement {
  const operation = operationRefForCodeFileTool(tool);
  const invocation = Object.freeze({ id: `file-${tool.toLowerCase()}-1`, operation });
  return Object.freeze({
    operationInvocation: invocation,
    operationResult: createOperationResult({
      ref: { invocation, id: `file-${tool.toLowerCase()}-result-1` },
      binding: bindingRefForCodeFileTool(tool),
      semanticOwner: "helarc.code-workspace",
      status: "succeeded",
      output: Object.freeze({ file_path: "empty.txt" }),
      failure: null,
      startedAt: NOW,
      finishedAt: NOW,
      lowerRefs: Object.freeze([]),
      metadata: Object.freeze({}),
    }),
    actionSettlement: Object.freeze({
      action: Object.freeze({ id: "canonical-file-action-1" }),
      id: "canonical-file-settlement-1",
    }),
    effectCertainty: "confirmed",
    costUnits: null,
  });
}

function shellCommandRequest() {
  return Object.freeze({
    command: "pnpm test",
    validation_claim: "tests",
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
