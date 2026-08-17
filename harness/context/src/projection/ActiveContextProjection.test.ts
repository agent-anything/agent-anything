import { describe, expect, it } from "vitest";
import {
  applyContextTransition,
  createEmptyActiveContext,
  type ContextAdmissionProfile,
} from "../active-context/index.js";
import {
  measureContextPayload,
  type ContextContribution,
  type ContextTransformationKind,
} from "../contribution/ContextContribution.js";
import {
  projectActiveContext,
  type ContextProjectionEstimator,
  type ContextProjectionPolicy,
} from "./ActiveContextProjection.js";

describe("Active Context projection", () => {
  it("projects eligible Contributions in deterministic precedence order", () => {
    const lower = contribution("lower", 10, "optional", ["model"]);
    const higher = contribution("higher", 20, "optional", ["model"]);
    const context = activeContext([lower, higher]);

    const result = project(context, 1_024);

    expect(result.status).toBe("projected");
    expect(result.projection?.blocks.map((block) => block.contribution.id))
      .toEqual(["higher", "lower"]);
    expect(result.manifest.records.map((record) => record.reason))
      .toEqual(["included_exact", "included_exact"]);
    expect(result.manifest.records[0]?.source.owner).toBe("runtime");
    expect(result.manifest.accounting.projectedItems).toBe(2);
  });

  it("records disclosure and lifecycle omissions without exposing payloads", () => {
    const hidden = contribution("hidden", 10, "optional", ["product"]);
    const invalidated = contribution("invalidated", 10, "optional", ["model"]);
    const added = activeContext([hidden, invalidated]);
    const context = applyContextTransition({
      context: added,
      transition: {
        id: "transition-invalidate",
        base: added.ref,
        proposer: { owner: "runtime", kind: "runner", id: "run-1" },
        cause: { kind: "test", id: null },
        correlationId: null,
        operations: [{
          kind: "invalidate",
          item: { id: "item-invalidated" },
          expectedContribution: invalidated.ref,
          reason: "stale",
        }],
        createdAt: at(2),
      },
      admission: profile(),
      maxContributionPayloadBytes: 1_024,
    });

    const result = project(context, 1_024);

    expect(result.status).toBe("projected");
    expect(result.projection?.blocks).toEqual([]);
    expect(result.manifest.records.map((record) => record.reason).sort())
      .toEqual(["omitted_disclosure", "omitted_invalidated"]);
    expect(JSON.stringify(result.manifest)).not.toContain("hidden-payload");
  });

  it("omits optional Contributions that exceed the granted budget", () => {
    const optional = contribution("optional", 10, "optional", ["model"]);
    const result = project(activeContext([optional]), 1);

    expect(result.status).toBe("projected");
    expect(result.projection?.blocks).toEqual([]);
    expect(result.manifest.records[0]?.reason).toBe("omitted_budget");
  });

  it("returns a complete blocked Manifest when mandatory content cannot fit", () => {
    const mandatory = contribution("mandatory", 20, "mandatory", ["model"]);
    const later = contribution("later", 10, "optional", ["model"]);
    const result = project(activeContext([mandatory, later]), 1);

    expect(result).toMatchObject({
      status: "blocked",
      projection: null,
      failure: { code: "context_projection_mandatory_overflow" },
    });
    expect(result.manifest.records.map((record) => record.reason)).toEqual([
      "blocked_mandatory_overflow",
      "blocked_prior_failure",
    ]);
  });

  it("stably truncates text only when Contribution and profile both permit it", () => {
    const value = contribution(
      "truncated",
      10,
      "optional",
      ["model"],
      ["truncate"],
      "abcdef",
    );
    const context = activeContext([value]);
    const result = projectActiveContext({
      context,
      request: request(context.ref, 3, ["truncate"]),
      estimator: byteEstimator,
      policy: allowPolicy,
      maxContributionPayloadBytes: 1_024,
    });

    expect(result.status).toBe("projected");
    expect(result.projection?.blocks[0]).toMatchObject({
      payload: { kind: "text", text: "abc" },
      transformation: { kind: "truncate" },
    });
    expect(result.manifest.records[0]).toMatchObject({
      disposition: "transformed",
      reason: "transformed_truncate",
      originalPayloadBytes: 6,
      projectedAmount: 3,
    });
  });

  it("applies a trusted redaction without granting payload-controlled policy", () => {
    const value = contribution(
      "redacted",
      10,
      "optional",
      ["model"],
      ["redact"],
      "private",
    );
    const context = activeContext([value]);
    const policy: ContextProjectionPolicy = {
      ref: allowPolicy.ref,
      decide: () => ({
        kind: "redact",
        code: "test_redaction",
        payload: { kind: "text", text: "[REDACTED]" },
      }),
    };
    const result = projectActiveContext({
      context,
      request: request(context.ref, 100, ["redact"]),
      estimator: byteEstimator,
      policy,
      maxContributionPayloadBytes: 1_024,
    });

    expect(result.status).toBe("projected");
    expect(result.projection?.blocks[0]).toMatchObject({
      payload: { kind: "text", text: "[REDACTED]" },
      transformation: { kind: "redact" },
    });
    expect(JSON.stringify(result.projection)).not.toContain("private");
  });

  it("fails closed when the estimator identity differs from the request", () => {
    const context = activeContext([
      contribution("value", 10, "optional", ["model"]),
    ]);

    expect(() => projectActiveContext({
      context,
      request: request(context.ref, 100),
      estimator: {
        ...byteEstimator,
        ref: { ...byteEstimator.ref, revision: "different" },
      },
      policy: allowPolicy,
      maxContributionPayloadBytes: 1_024,
    })).toThrow("estimator does not match");
  });
});

const byteEstimator: ContextProjectionEstimator = Object.freeze({
  ref: Object.freeze({
    id: "utf8-bytes",
    revision: "1",
    unit: "bytes",
    accuracy: "exact",
  }),
  estimate(input) {
    return measureContextPayload(input.payload).payloadBytes;
  },
});

const allowPolicy: ContextProjectionPolicy = Object.freeze({
  ref: Object.freeze({ id: "context-policy", revision: "1" }),
  decide() {
    return Object.freeze({ kind: "allow" as const });
  },
});

function project(
  context: ReturnType<typeof activeContext>,
  maximum: number,
) {
  return projectActiveContext({
    context,
    request: request(context.ref, maximum),
    estimator: byteEstimator,
    policy: allowPolicy,
    maxContributionPayloadBytes: 1_024,
  });
}

function activeContext(contributions: readonly ContextContribution[]) {
  const empty = createEmptyActiveContext({
    id: "context-1",
    runId: "run-1",
    createdAt: at(0),
  });
  return applyContextTransition({
    context: empty,
    transition: {
      id: "transition-add",
      base: empty.ref,
      proposer: { owner: "runtime", kind: "runner", id: "run-1" },
      cause: { kind: "test", id: null },
      correlationId: null,
      operations: contributions.map((value) => ({
        kind: "add" as const,
        item: { id: `item-${value.ref.id}` },
        contribution: value,
      })),
      createdAt: at(1),
    },
    admission: profile(),
    maxContributionPayloadBytes: 1_024,
  });
}

function contribution(
  id: string,
  precedence: number,
  necessity: "mandatory" | "optional",
  audiences: readonly string[],
  transformations: readonly ContextTransformationKind[] = [],
  text = `${id}-payload`,
): ContextContribution {
  const payload = Object.freeze({ kind: "text" as const, text });
  return Object.freeze({
    ref: Object.freeze({ id, revision: "1" }),
    source: Object.freeze({ owner: "runtime", kind: "test", id, revision: "1", observedAt: at(1) }),
    payload,
    scope: Object.freeze({ runId: "run-1", ownerScope: null }),
    disclosure: Object.freeze({ sensitivity: "internal" as const, audiences: Object.freeze([...audiences]) }),
    handling: Object.freeze({
      retention: "history" as const,
      replacementKey: null,
      instructionRole: "data" as const,
      necessity,
      precedence,
      allowedTransformations: Object.freeze([...transformations]),
    }),
    provenance: Object.freeze([{ owner: "runtime", kind: "test", id, revision: "1" }]),
    createdAt: at(1),
    accounting: measureContextPayload(payload),
  });
}

function profile(): ContextAdmissionProfile {
  return Object.freeze({
    ref: Object.freeze({ id: "runtime-admission", revision: "1" }),
    owner: "runtime",
    sourceKinds: Object.freeze(["test"]),
    disclosure: Object.freeze({ sensitivity: "internal", audiences: Object.freeze(["model", "product"]) }),
    retention: Object.freeze(["history"]),
    instructionRoles: Object.freeze(["data"]),
    necessities: Object.freeze(["mandatory", "optional"]),
    maximumPrecedence: 100,
    transformations: Object.freeze(["truncate", "redact"]),
  });
}

function request(
  activeContext: { readonly id: string; readonly runId: string; readonly version: number },
  maximum: number,
  transformations: readonly ContextTransformationKind[] = [],
) {
  return Object.freeze({
    id: `projection-request-${maximum}`,
    activeContext,
    consumer: Object.freeze({ owner: "agent-core", kind: "controller", id: "agent-1" }),
    purpose: "controller_decision",
    profile: Object.freeze({
      ref: Object.freeze({ id: "controller-profile", revision: "1" }),
      ordering: "precedence_desc_created_at_asc_id_asc" as const,
      allowedTransformations: Object.freeze([...transformations]),
    }),
    budget: Object.freeze({ unit: "bytes" as const, maximum }),
    policy: allowPolicy.ref,
    estimator: byteEstimator.ref,
    audiences: Object.freeze(["model"]),
    mandatoryItems: Object.freeze([]),
    requestedAt: at(3),
  });
}

function at(offset: number): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offset * 1_000).toISOString();
}
