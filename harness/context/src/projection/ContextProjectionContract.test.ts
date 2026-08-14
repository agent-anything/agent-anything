import { describe, expect, it } from "vitest";
import { ContextContractError } from "../contract/ContextContract.js";
import {
  snapshotContextProjection,
  snapshotContextProjectionRequest,
  snapshotProjectionManifest,
} from "./ContextProjection.js";

describe("Context Projection contracts", () => {
  it("snapshots an exact consumer, policy, estimator, and budget request", () => {
    const request = snapshotContextProjectionRequest({
      id: "projection-request-1",
      activeContext: { id: "context-1", runId: "run-1", version: 3 },
      consumer: { owner: "helarc", kind: "controller", id: "primary" },
      purpose: "controller_decision",
      profile: {
        ref: { id: "helarc-controller", revision: "1" },
        ordering: "precedence_desc_created_at_asc_id_asc",
        allowedTransformations: ["truncate", "redact", "reference"],
      },
      budget: { unit: "tokens", maximum: 4096 },
      policy: { id: "context-policy", revision: "4" },
      estimator: { id: "provider-tokenizer", revision: "1", unit: "tokens" },
      audiences: ["provider:primary"],
      requestedAt: "2026-08-14T00:00:03.000Z",
    });

    expect(request.activeContext.version).toBe(3);
    expect(Object.isFrozen(request.profile.allowedTransformations)).toBe(true);
  });

  it("rejects generic metadata escape hatches", () => {
    expect(() => snapshotContextProjectionRequest({
      id: "projection-request-1",
      activeContext: { id: "context-1", runId: "run-1", version: 3 },
      consumer: { owner: "helarc", kind: "controller", id: "primary" },
      purpose: "controller_decision",
      profile: {
        ref: { id: "helarc-controller", revision: "1" },
        ordering: "precedence_desc_created_at_asc_id_asc",
        allowedTransformations: [],
      },
      budget: { unit: "tokens", maximum: 4096 },
      policy: { id: "context-policy", revision: "4" },
      estimator: { id: "provider-tokenizer", revision: "1", unit: "tokens" },
      audiences: ["provider:primary"],
      requestedAt: "2026-08-14T00:00:03.000Z",
      metadata: { bypass: true },
    } as never)).toThrow(ContextContractError);
  });

  it("requires one accounted Manifest record per considered item", () => {
    const manifest = snapshotProjectionManifest({
      id: "manifest-1",
      projectionId: "projection-1",
      requestId: "projection-request-1",
      activeContext: { id: "context-1", runId: "run-1", version: 3 },
      profile: { id: "helarc-controller", revision: "1" },
      policy: { id: "context-policy", revision: "4" },
      estimator: { id: "provider-tokenizer", revision: "1", unit: "tokens" },
      records: [{
        item: { id: "item-1" },
        contribution: { id: "contribution-1", revision: "1" },
        disposition: "included",
        reason: "included_exact",
        originalPayloadBytes: 5,
        projectedAmount: 2,
      }, {
        item: { id: "item-2" },
        contribution: { id: "contribution-2", revision: "1" },
        disposition: "omitted",
        reason: "omitted_budget",
        originalPayloadBytes: 10,
        projectedAmount: 0,
      }],
      accounting: {
        unit: "tokens",
        consideredItems: 2,
        projectedItems: 1,
        projectedAmount: 2,
      },
      createdAt: "2026-08-14T00:00:03.000Z",
    });

    expect(manifest.records).toHaveLength(2);
    expect(Object.isFrozen(manifest.records)).toBe(true);
  });

  it("keeps raw payload bytes separate from Provider token accounting", () => {
    const projection = snapshotContextProjection({
      id: "projection-1",
      requestId: "projection-request-1",
      activeContext: { id: "context-1", runId: "run-1", version: 3 },
      estimator: { id: "provider-tokenizer", revision: "1", unit: "tokens" },
      blocks: [{
        id: "block-1",
        item: { id: "item-1" },
        contribution: { id: "contribution-1", revision: "1" },
        instructionRole: "data",
        payload: { kind: "text", text: "hello" },
        accounting: { unit: "tokens", amount: 2 },
        transformation: {
          kind: "truncate",
          originalPayloadBytes: 12,
        },
      }],
      accounting: { unit: "tokens", amount: 2 },
      manifestId: "manifest-1",
      createdAt: "2026-08-14T00:00:03.000Z",
    });

    expect(projection.blocks[0]?.accounting).toEqual({
      unit: "tokens",
      amount: 2,
    });
    expect(projection.blocks[0]?.transformation?.originalPayloadBytes).toBe(12);
  });
});
