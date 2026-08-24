import { describe, expect, it } from "vitest";
import { createOperationCatalogSnapshot } from "@agent-anything/operation-catalog/catalog";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import { createToolContractIdentity, type ToolRevisionRef } from "../identity/index.js";
import { materializeToolCall } from "../invocation/index.js";
import { createToolRegistrationSnapshot, type ToolRegistrationInput } from "../registration/index.js";
import {
  createStaticAvailableToolBindingAssessment,
  createToolBindingAvailabilityAssessment,
  type ToolBindingAvailabilityAssessment,
  type ToolBindingAvailabilityDisposition,
  type ToolBindingUnavailableReason,
  type ToolExposureBasisRef,
} from "./ToolAvailability.js";
import {
  createToolExposureProof,
  resolveCurrentTurnToolExposure,
  snapshotCurrentTurnToolExposure,
  snapshotToolExposureProof,
} from "./ToolExposure.js";
import { createFixedLocalToolSelection, type ToolSelectionRevision } from "./ToolSelection.js";

describe("current-turn Tool Exposure", () => {
  it("derives the exact model-visible subset and excludes workflow-only Tools", () => {
    const selection = createSelection([
      ["read-file", ["model", "workflow"]],
      ["create-file", ["model"]],
      ["validate-file", ["workflow"]],
    ]);
    const basis = [basisRef("run", "1")];
    const exposure = resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [
        assessment(selection, "read-file", basis, "available", null),
        assessment(selection, "create-file", basis, "unavailable", "no_eligible_subject"),
      ],
    });

    expect(exposure.catalog.tools.map((tool) => tool.name)).toEqual(["codeAgent.readFile"]);
    expect(exposure.exposedTools).toEqual([toolRevision("read-file")]);
    expect(exposure.omissions).toEqual([
      expect.objectContaining({
        tool: toolRevision("create-file"),
        reason: "no_eligible_subject",
      }),
    ]);
    expect(exposure.omissions.some((omission) => "description" in omission)).toBe(false);
    expect(Object.keys(exposure.omissions[0]!).sort()).toEqual([
      "assessmentRevision",
      "binding",
      "reason",
      "tool",
    ]);
  });

  it("supports many unavailable bindings and an exact empty Catalog", () => {
    const selection = createSelection([
      ["read-file", ["model"]],
      ["create-file", ["model"]],
    ]);
    const basis = [basisRef("run", "1")];
    const exposure = resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [
        assessment(selection, "create-file", basis, "unavailable", "resource_exhausted"),
        assessment(selection, "read-file", basis, "unavailable", "binding_inactive"),
      ],
    });

    expect(exposure.exposedTools).toEqual([]);
    expect(exposure.catalog.tools).toEqual([]);
    expect(exposure.omissions.map(({ reason }) => reason)).toEqual([
      "resource_exhausted",
      "binding_inactive",
    ]);
  });

  it("requires one exact assessment for every selected model Tool", () => {
    const selection = createSelection([
      ["read-file", ["model"]],
      ["create-file", ["model"]],
    ]);
    const basis = [basisRef("run", "1")];
    const read = assessment(selection, "read-file", basis, "available", null);

    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [read],
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_assessment_missing" }));
    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [read, read],
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_assessment_duplicate" }));
  });

  it("rejects wrong Tool, binding, selection, stale basis, and assessment revision", () => {
    const selection = createSelection([
      ["read-file", ["model"]],
      ["create-file", ["model"]],
    ]);
    const currentBasis = [basisRef("run", "2")];
    const staleBasis = [basisRef("run", "1")];
    const read = assessment(selection, "read-file", currentBasis, "available", null);
    const create = assessment(selection, "create-file", currentBasis, "available", null);

    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: currentBasis,
      assessments: [forgeAssessment(read, { tool: toolRevision("unknown") }), create],
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_assessment_tool_invalid" }));
    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: currentBasis,
      assessments: [forgeAssessment(read, { binding: create.binding }), create],
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_assessment_binding_invalid" }));
    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: currentBasis,
      assessments: [forgeAssessment(read, { selectionRevision: "stale-selection" }), create],
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_assessment_selection_invalid" }));
    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: currentBasis,
      assessments: [assessment(selection, "read-file", staleBasis, "available", null), create],
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_basis_stale" }));
    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: currentBasis,
      assessments: [{ ...read, revision: "invalid-revision" }, create],
    })).toThrowError(expect.objectContaining({ code: "tool_availability_revision_invalid" }));
  });

  it("rejects contradictory availability instead of guessing unavailable", () => {
    const selection = createSelection([["read-file", ["model"]]]);
    const basis = [basisRef("run", "1")];
    const available = assessment(selection, "read-file", basis, "available", null);

    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [{ ...available, reason: "resource_exhausted" }],
    })).toThrowError(expect.objectContaining({ code: "tool_availability_reason_invalid" }));
    expect(() => resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [{ ...available, ownerState: { credential: "secret" } } as ToolBindingAvailabilityAssessment],
    })).toThrowError(expect.objectContaining({ code: "tool_availability_invalid" }));
    expect(() => createToolBindingAvailabilityAssessment({
      selection,
      tool: toolRevision("read-file"),
      basisRefs: [],
      disposition: "available",
      reason: null,
    })).toThrowError(expect.objectContaining({ code: "tool_exposure_basis_invalid" }));
  });

  it("keeps content, basis, and request-proof identities distinct", () => {
    const selection = createSelection([["read-file", ["model"]]]);
    const firstBasis = [basisRef("run", "1")];
    const secondBasis = [basisRef("run", "2")];
    const first = resolveCurrentTurnToolExposure(selection, {
      basisRefs: firstBasis,
      assessments: [assessment(selection, "read-file", firstBasis, "available", null)],
    });
    const second = resolveCurrentTurnToolExposure(selection, {
      basisRefs: secondBasis,
      assessments: [assessment(selection, "read-file", secondBasis, "available", null)],
    });
    const firstRequest = createToolExposureProof(first, "controller-request-1");
    const nextRequest = createToolExposureProof(first, "controller-request-2");

    expect(first.contentRevision).toBe(second.contentRevision);
    expect(first.basis.revision).not.toBe(second.basis.revision);
    expect(firstRequest.contentRevision).toBe(nextRequest.contentRevision);
    expect(firstRequest.basisRevision).toBe(nextRequest.basisRevision);
    expect(firstRequest.id).not.toBe(nextRequest.id);
    expect(firstRequest.id).not.toBe(first.contentRevision);
    expect(firstRequest.id).not.toBe(first.basis.revision);
  });

  it("is deterministic across input order and snapshots immutable exact values", () => {
    const selection = createSelection([
      ["read-file", ["model"]],
      ["create-file", ["model"]],
    ]);
    const refs = [basisRef("workspace", "1"), basisRef("run", "1")];
    const read = assessment(selection, "read-file", refs, "available", null);
    const create = assessment(selection, "create-file", refs, "unavailable", "execution_path_unavailable");
    const left = resolveCurrentTurnToolExposure(selection, {
      basisRefs: refs,
      assessments: [read, create],
    });
    const right = resolveCurrentTurnToolExposure(selection, {
      basisRefs: [...refs].reverse(),
      assessments: [create, read],
    });
    const proof = createToolExposureProof(left, "controller-request-1");

    expect(left).toEqual(right);
    expect(snapshotCurrentTurnToolExposure(left)).toEqual(left);
    expect(snapshotToolExposureProof(proof)).toEqual(proof);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.basis)).toBe(true);
    expect(Object.isFrozen(left.basis.refs)).toBe(true);
    expect(Object.isFrozen(left.exposedTools)).toBe(true);
    expect(Object.isFrozen(left.catalog)).toBe(true);
    expect(Object.isFrozen(left.omissions)).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
  });

  it("uses explicit static assessments without bypassing resolver coverage", () => {
    const selection = createSelection([["read-file", ["model"]]]);
    const staticAssessment = createStaticAvailableToolBindingAssessment(
      selection,
      toolRevision("read-file"),
    );
    const exposure = resolveCurrentTurnToolExposure(selection, {
      basisRefs: staticAssessment.basisRefs,
      assessments: [staticAssessment],
    });

    expect(staticAssessment.disposition).toBe("available");
    expect(staticAssessment.reason).toBeNull();
    expect(exposure.exposedTools).toEqual([toolRevision("read-file")]);
  });

  it("binds Tool Call materialization to the exact request exposure", () => {
    const selection = createSelection([
      ["read-file", ["model"]],
      ["create-file", ["model"]],
    ]);
    const basis = [basisRef("run", "1")];
    const exposure = resolveCurrentTurnToolExposure(selection, {
      basisRefs: basis,
      assessments: [
        assessment(selection, "read-file", basis, "available", null),
        assessment(selection, "create-file", basis, "unavailable", "no_eligible_subject"),
      ],
    });
    const proof = createToolExposureProof(exposure, "controller-request-1");
    const common = {
      selection,
      exposure: proof,
      parentRunAction: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
      toolCallId: "tool-call-1",
      createdAt: "2026-08-24T00:00:00.000Z",
      validateInput: () => true,
    };

    expect(materializeToolCall({
      ...common,
      candidate: {
        name: "codeAgent.createFile",
        revision: "1",
        input: {},
        origin: "model",
        controllerRequestId: "controller-request-1",
      },
    })).toEqual(expect.objectContaining({ status: "rejected", code: "tool_not_exposed" }));
    expect(materializeToolCall({
      ...common,
      candidate: {
        name: "codeAgent.readFile",
        revision: "1",
        input: {},
        origin: "model",
        controllerRequestId: "controller-request-stale",
      },
    })).toEqual(expect.objectContaining({ status: "rejected", code: "tool_not_exposed" }));
    expect(materializeToolCall({
      ...common,
      candidate: {
        name: "codeAgent.readFile",
        revision: "1",
        input: {},
        origin: "model",
        controllerRequestId: "controller-request-1",
      },
    }).status).toBe("trusted");
  });
});

function assessment(
  selection: ToolSelectionRevision,
  name: string,
  basisRefs: readonly ToolExposureBasisRef[],
  disposition: ToolBindingAvailabilityDisposition,
  reason: ToolBindingUnavailableReason | null,
): ToolBindingAvailabilityAssessment {
  return createToolBindingAvailabilityAssessment({
    selection,
    tool: toolRevision(name),
    basisRefs,
    disposition,
    reason,
  });
}

function forgeAssessment(
  assessment: ToolBindingAvailabilityAssessment,
  changes: Partial<Pick<ToolBindingAvailabilityAssessment, "tool" | "binding" | "selectionRevision">>,
): ToolBindingAvailabilityAssessment {
  const base = {
    tool: changes.tool ?? assessment.tool,
    binding: changes.binding ?? assessment.binding,
    selectionRevision: changes.selectionRevision ?? assessment.selectionRevision,
    basisRefs: assessment.basisRefs,
    disposition: assessment.disposition,
    reason: assessment.reason,
  };
  return {
    schemaVersion: 1,
    ...base,
    revision: createToolContractIdentity("agent-anything.tool-binding-availability.v1", base),
  };
}

function basisRef(kind: string, revision: string): ToolExposureBasisRef {
  return { owner: "agent-core", kind, id: `${kind}-1`, revision };
}

function createSelection(
  tools: readonly [name: string, origins: readonly ("model" | "workflow")[]][],
): ToolSelectionRevision {
  const operations = tools.map(([name]) => operationRevision(name));
  const operationCatalog = createOperationCatalog(operations);
  const registrations = createToolRegistrationSnapshot(
    operationCatalog,
    tools.map(([name]) => registration(`codeAgent.${camel(name)}`, name, operationRevision(name))),
  );
  return createFixedLocalToolSelection(
    registrations,
    operationCatalog,
    tools.map(([name, origins]) => ({ tool: toolRevision(name), origins })),
  );
}

function toolRevision(name: string): ToolRevisionRef {
  return { tool: { namespace: "code-agent", name }, revision: "1" };
}

function operationRevision(name: string): OperationRevisionRef {
  return { operation: { namespace: "code", name }, revision: "1" };
}

function createOperationCatalog(operations: readonly OperationRevisionRef[]) {
  return createOperationCatalogSnapshot({
    id: "operation-catalog-1",
    revision: "1",
    entries: operations.map((ref) => ({
      admissionId: `operation-admission-${ref.operation.name}`,
      operation: {
        ref,
        semanticOwner: "code-workspace",
        requestSchemaRevision: "request-1",
        resultSchemaRevision: "result-1",
        roles: {
          requestOrigins: ["tool_request", "trusted_workflow"],
          exposure: "eager_tool",
          runControl: "internal",
          trust: "effect_free",
          participation: "semantic_owner",
          domainPurpose: `code.${ref.operation.name}`,
        },
      },
      binding: {
        ref: { operation: ref, revision: "binding-1" },
        kind: "internal",
        resolverId: `resolver.${ref.operation.name}`,
        resolverRevision: "1",
      },
      sourceRevision: "source-1",
      allowedRequestOrigins: ["tool_request", "trusted_workflow"],
      admittedAt: "2026-08-13T00:00:00.000Z",
      retirement: null,
    })),
  });
}

function registration(
  name: string,
  keyName: string,
  operation: OperationRevisionRef,
): ToolRegistrationInput {
  return {
    admissionId: `tool-admission-${keyName}`,
    descriptor: {
      ref: toolRevision(keyName),
      name,
      description: `Descriptor for ${name}.`,
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "input-1",
        output: null,
        translation: "native-1",
      },
      source: {
        kind: "product",
        sourceId: "helarc-code-agent",
        sourceRevision: "1",
        activationEpoch: null,
      },
      binding: { kind: "operation", operation, revision: "binding-1" },
    },
    allowedOrigins: ["model", "workflow"],
    admittedAt: "2026-08-13T00:00:00.000Z",
  };
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_match, value: string) => value.toUpperCase());
}
