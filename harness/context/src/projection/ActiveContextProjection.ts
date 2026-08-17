import type {
  ActiveContext,
  ActiveContextItem,
  RetainedActiveContextItem,
} from "../active-context/ActiveContext.js";
import { snapshotActiveContext } from "../active-context/ActiveContext.js";
import type {
  ContextContribution,
  ContextPayload,
} from "../contribution/ContextContribution.js";
import { measureContextPayload } from "../contribution/ContextContribution.js";
import { fail } from "../contract/ContextContractValidation.js";
import type {
  ContextEstimatorRef,
  ContextPolicyRef,
  ContextProjection,
  ContextProjectionBlock,
  ContextProjectionRequest,
  ContextProjectionTransformation,
  ProjectionManifest,
  ProjectionManifestRecord,
} from "./ContextProjection.js";
import {
  snapshotContextProjection,
  snapshotContextProjectionRequest,
  snapshotProjectionManifest,
} from "./ContextProjection.js";

export interface ContextProjectionEstimationInput {
  readonly item: RetainedActiveContextItem["ref"];
  readonly contribution: ContextContribution["ref"];
  readonly instructionRole: ContextContribution["handling"]["instructionRole"];
  readonly payload: ContextPayload;
  readonly transformation: ContextProjectionTransformation | null;
}

export interface ContextProjectionEstimator {
  readonly ref: ContextEstimatorRef;
  estimate(input: ContextProjectionEstimationInput): number;
}

export type ContextProjectionPolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "reject"; readonly code: string }
  | {
      readonly kind: "redact";
      readonly code: string;
      readonly payload: ContextPayload;
    };

export interface ContextProjectionPolicy {
  readonly ref: ContextPolicyRef;
  decide(input: {
    readonly request: ContextProjectionRequest;
    readonly item: RetainedActiveContextItem["ref"];
    readonly contribution: ContextContribution;
  }): ContextProjectionPolicyDecision;
}

export interface ContextProjectionFailure {
  readonly code:
    | "context_projection_mandatory_overflow"
    | "context_projection_mandatory_rejected";
  readonly item: RetainedActiveContextItem["ref"];
  readonly contribution: ContextContribution["ref"];
  readonly message: string;
}

export type ActiveContextProjectionResult =
  | {
      readonly status: "projected";
      readonly projection: ContextProjection;
      readonly manifest: ProjectionManifest;
      readonly failure: null;
    }
  | {
      readonly status: "blocked";
      readonly projection: null;
      readonly manifest: ProjectionManifest;
      readonly failure: ContextProjectionFailure;
    };

export function projectActiveContext(input: {
  readonly context: ActiveContext;
  readonly request: ContextProjectionRequest;
  readonly estimator: ContextProjectionEstimator;
  readonly policy: ContextProjectionPolicy;
  readonly maxContributionPayloadBytes: number;
}): ActiveContextProjectionResult {
  const context = snapshotActiveContext(input.context, {
    maxContributionPayloadBytes: input.maxContributionPayloadBytes,
  });
  const request = snapshotContextProjectionRequest(input.request);
  assertRequestMatchesContext(request, context);
  assertEstimatorMatches(request.estimator, input.estimator.ref);
  assertPolicyMatches(request.policy, input.policy.ref);

  const ordered = [...context.items].sort(compareItems);
  const blocks: ContextProjectionBlock[] = [];
  const records: ProjectionManifestRecord[] = [];
  const mandatoryItems = new Set(request.mandatoryItems.map((item) => item.id));
  const seenContributions = new Set<string>();
  let used = 0;
  let failure: ContextProjectionFailure | null = null;

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index]!;
    const contributionRef = "contribution" in item
      ? item.contribution.ref
      : item.contributionRef;
    const source = "contribution" in item ? item.contribution.source : item.source;
    const originalPayloadBytes = "contribution" in item
      ? item.contribution.accounting.payloadBytes
      : 0;

    if (!("contribution" in item)) {
      records.push(record(item, contributionRef, source, "omitted", "omitted_removed", originalPayloadBytes, 0, null));
      continue;
    }
    if (item.lifecycle.kind === "invalidated") {
      records.push(record(item, contributionRef, source, "omitted", "omitted_invalidated", originalPayloadBytes, 0, null));
      continue;
    }
    if (item.contribution.scope.runId !== context.ref.runId) {
      records.push(record(item, contributionRef, source, "omitted", "omitted_scope", originalPayloadBytes, 0, null));
      continue;
    }
    if (!request.audiences.every((audience) =>
      item.contribution.disclosure.audiences.includes(audience)
    )) {
      records.push(record(item, contributionRef, source, "omitted", "omitted_disclosure", originalPayloadBytes, 0, null));
      continue;
    }
    const contributionIdentity = `${contributionRef.id}@${contributionRef.revision}`;
    if (seenContributions.has(contributionIdentity)) {
      records.push(record(item, contributionRef, source, "omitted", "omitted_duplicate", originalPayloadBytes, 0, null));
      continue;
    }
    seenContributions.add(contributionIdentity);

    if (failure !== null) {
      records.push(record(item, contributionRef, source, "blocked", "blocked_prior_failure", originalPayloadBytes, 0, null));
      continue;
    }

    const mandatory = mandatoryItems.has(item.ref.id) ||
      item.contribution.handling.necessity === "mandatory";
    const policyDecision = snapshotPolicyDecision(input.policy.decide({
      request,
      item: item.ref,
      contribution: item.contribution,
    }));
    if (policyDecision.kind === "reject") {
      if (mandatory) {
        failure = projectionFailureRecord(
          "context_projection_mandatory_rejected",
          item,
          "Mandatory Context Contribution was rejected by projection policy.",
        );
        records.push(record(item, contributionRef, source, "blocked", "blocked_mandatory_rejected", originalPayloadBytes, 0, null));
      } else {
        records.push(record(item, contributionRef, source, "rejected", "rejected_policy", originalPayloadBytes, 0, null));
      }
      continue;
    }

    const transformed = policyDecision.kind === "redact"
      ? redactedCandidate(item, policyDecision.payload, request)
      : null;
    if (policyDecision.kind === "redact" && transformed === null) {
      if (mandatory) {
        failure = projectionFailureRecord(
          "context_projection_mandatory_rejected",
          item,
          "Mandatory Context Contribution required a disallowed redaction.",
        );
        records.push(record(item, contributionRef, source, "blocked", "blocked_mandatory_rejected", originalPayloadBytes, 0, null));
      } else {
        records.push(record(item, contributionRef, source, "rejected", "rejected_policy", originalPayloadBytes, 0, null));
      }
      continue;
    }

    const payload = transformed?.payload ?? item.contribution.payload;
    const transformation = transformed?.transformation ?? null;
    const amount = estimate(input.estimator, item, payload, transformation);
    if (used + amount <= request.budget.maximum) {
      const disposition = payload.kind === "reference"
        ? "referenced" as const
        : transformation === null ? "included" as const : "transformed" as const;
      const reason = payload.kind === "reference"
        ? "transformed_reference" as const
        : transformation?.kind === "redact"
          ? "transformed_redact" as const
          : "included_exact" as const;
      const block = createBlock(request, item, payload, amount, transformation);
      blocks.push(block);
      records.push(record(item, contributionRef, source, disposition, reason, originalPayloadBytes, amount, transformation ?? (payload.kind === "reference"
        ? Object.freeze({ kind: "reference" as const, originalPayloadBytes })
        : null)));
      used += amount;
      continue;
    }

    const truncated = transformation === null
      ? truncateToFit(input.estimator, request, item, request.budget.maximum - used)
      : null;
    if (truncated !== null) {
      const block = createBlock(
        request,
        item,
        truncated.payload,
        truncated.amount,
        truncated.transformation,
      );
      blocks.push(block);
      records.push(record(item, contributionRef, source, "transformed", "transformed_truncate", originalPayloadBytes, truncated.amount, truncated.transformation));
      used += truncated.amount;
      continue;
    }

    if (mandatory) {
      failure = projectionFailureRecord(
        "context_projection_mandatory_overflow",
        item,
        "Mandatory Context Contribution exceeds the granted Context budget.",
      );
      records.push(record(item, contributionRef, source, "blocked", "blocked_mandatory_overflow", originalPayloadBytes, 0, null));
    } else {
      records.push(record(item, contributionRef, source, "omitted", "omitted_budget", originalPayloadBytes, 0, null));
    }
  }

  const projectionId = `${request.id}:projection`;
  const manifestId = `${request.id}:manifest`;
  const manifest = snapshotProjectionManifest({
    id: manifestId,
    projectionId,
    requestId: request.id,
    activeContext: context.ref,
    profile: request.profile.ref,
    policy: request.policy,
    estimator: request.estimator,
    budget: request.budget,
    records: Object.freeze(records),
    accounting: Object.freeze({
      unit: request.estimator.unit,
      consideredItems: records.length,
      projectedItems: blocks.length,
      projectedAmount: used,
    }),
    createdAt: request.requestedAt,
  });

  if (failure !== null) {
    return Object.freeze({
      status: "blocked",
      projection: null,
      manifest,
      failure,
    });
  }

  const projection = snapshotContextProjection({
    id: projectionId,
    requestId: request.id,
    activeContext: context.ref,
    estimator: request.estimator,
    blocks: Object.freeze(blocks),
    accounting: Object.freeze({ unit: request.estimator.unit, amount: used }),
    manifestId,
    createdAt: request.requestedAt,
  });
  return Object.freeze({
    status: "projected",
    projection,
    manifest,
    failure: null,
  });
}

function assertRequestMatchesContext(
  request: ContextProjectionRequest,
  context: ActiveContext,
): void {
  if (
    request.activeContext.id !== context.ref.id ||
    request.activeContext.runId !== context.ref.runId ||
    request.activeContext.version !== context.ref.version
  ) {
    projectionContractFailure(
      "ContextProjectionRequest does not identify the exact Active Context version.",
      "ContextProjectionRequest.activeContext",
    );
  }
  const knownItems = new Set(context.items.map((item) => item.ref.id));
  if (request.mandatoryItems.some((item) => !knownItems.has(item.id))) {
    projectionContractFailure(
      "ContextProjectionRequest identifies an unknown mandatory item.",
      "ContextProjectionRequest.mandatoryItems",
    );
  }
}

function assertEstimatorMatches(
  request: ContextEstimatorRef,
  actual: ContextEstimatorRef,
): void {
  if (
    request.id !== actual.id ||
    request.revision !== actual.revision ||
    request.unit !== actual.unit ||
    request.accuracy !== actual.accuracy
  ) {
    projectionContractFailure(
      "Context Projection estimator does not match the request.",
      "ContextProjectionRequest.estimator",
    );
  }
}

function assertPolicyMatches(
  request: ContextPolicyRef,
  actual: ContextPolicyRef,
): void {
  if (request.id !== actual.id || request.revision !== actual.revision) {
    projectionContractFailure(
      "Context Projection policy does not match the request.",
      "ContextProjectionRequest.policy",
    );
  }
}

function createBlock(
  request: ContextProjectionRequest,
  item: RetainedActiveContextItem,
  payload: ContextPayload,
  amount: number,
  transformation: ContextProjectionTransformation | null,
): ContextProjectionBlock {
  return Object.freeze({
    id: `${request.id}:block:${item.ref.id}`,
    item: item.ref,
    contribution: item.contribution.ref,
    instructionRole: item.contribution.handling.instructionRole,
    payload,
    accounting: Object.freeze({ unit: request.estimator.unit, amount }),
    transformation,
  });
}

function redactedCandidate(
  item: RetainedActiveContextItem,
  payload: ContextPayload,
  request: ContextProjectionRequest,
): { readonly payload: ContextPayload; readonly transformation: ContextProjectionTransformation } | null {
  if (
    !item.contribution.handling.allowedTransformations.includes("redact") ||
    !request.profile.allowedTransformations.includes("redact")
  ) {
    return null;
  }
  measureContextPayload(payload);
  return Object.freeze({
    payload,
    transformation: Object.freeze({
      kind: "redact" as const,
      originalPayloadBytes: item.contribution.accounting.payloadBytes,
    }),
  });
}

function truncateToFit(
  estimator: ContextProjectionEstimator,
  request: ContextProjectionRequest,
  item: RetainedActiveContextItem,
  remaining: number,
): {
  readonly payload: ContextPayload;
  readonly amount: number;
  readonly transformation: ContextProjectionTransformation;
} | null {
  if (
    remaining < 0 ||
    item.contribution.payload.kind !== "text" ||
    !item.contribution.handling.allowedTransformations.includes("truncate") ||
    !request.profile.allowedTransformations.includes("truncate")
  ) {
    return null;
  }
  const characters = Array.from(item.contribution.payload.text);
  let low = 0;
  let high = characters.length;
  let best: { readonly payload: ContextPayload; readonly amount: number } | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const payload = Object.freeze({
      kind: "text" as const,
      text: characters.slice(0, middle).join(""),
    });
    const transformation = Object.freeze({
      kind: "truncate" as const,
      originalPayloadBytes: item.contribution.accounting.payloadBytes,
    });
    const amount = estimate(estimator, item, payload, transformation);
    if (amount <= remaining) {
      best = Object.freeze({ payload, amount });
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === null || best.payload.kind !== "text" || best.payload.text.length === 0) {
    return null;
  }
  return Object.freeze({
    ...best,
    transformation: Object.freeze({
      kind: "truncate" as const,
      originalPayloadBytes: item.contribution.accounting.payloadBytes,
    }),
  });
}

function estimate(
  estimator: ContextProjectionEstimator,
  item: RetainedActiveContextItem,
  payload: ContextPayload,
  transformation: ContextProjectionTransformation | null,
): number {
  const amount = estimator.estimate(Object.freeze({
    item: item.ref,
    contribution: item.contribution.ref,
    instructionRole: item.contribution.handling.instructionRole,
    payload,
    transformation,
  }));
  if (!Number.isSafeInteger(amount) || amount < 0) {
    projectionContractFailure(
      "Context Projection estimator returned an invalid amount.",
      "ContextProjectionEstimator.estimate",
    );
  }
  return amount;
}

function compareItems(left: ActiveContextItem, right: ActiveContextItem): number {
  const leftContribution = "contribution" in left ? left.contribution : null;
  const rightContribution = "contribution" in right ? right.contribution : null;
  const precedence = (rightContribution?.handling.precedence ?? -1) -
    (leftContribution?.handling.precedence ?? -1);
  if (precedence !== 0) return precedence;
  const createdAt = (leftContribution?.createdAt ?? "").localeCompare(
    rightContribution?.createdAt ?? "",
  );
  return createdAt !== 0 ? createdAt : left.ref.id.localeCompare(right.ref.id);
}

function record(
  item: ActiveContextItem,
  contribution: { readonly id: string; readonly revision: string },
  source: ContextContribution["source"],
  disposition: ProjectionManifestRecord["disposition"],
  reason: ProjectionManifestRecord["reason"],
  originalPayloadBytes: number,
  projectedAmount: number,
  transformation: ContextProjectionTransformation | null,
): ProjectionManifestRecord {
  return Object.freeze({
    item: item.ref,
    contribution,
    source,
    disposition,
    reason,
    originalPayloadBytes,
    projectedAmount,
    transformation,
  });
}

function projectionFailureRecord(
  code: ContextProjectionFailure["code"],
  item: RetainedActiveContextItem,
  message: string,
): ContextProjectionFailure {
  return Object.freeze({
    code,
    item: item.ref,
    contribution: item.contribution.ref,
    message,
  });
}

function snapshotPolicyDecision(
  input: ContextProjectionPolicyDecision,
): ContextProjectionPolicyDecision {
  if (input === null || typeof input !== "object") {
    return projectionContractFailure(
      "Context Projection policy returned an invalid decision.",
      "ContextProjectionPolicy.decide",
    );
  }
  if (input.kind === "allow") return Object.freeze({ kind: "allow" });
  if (input.kind === "reject" && typeof input.code === "string" && input.code.trim()) {
    return Object.freeze({ kind: "reject", code: input.code.trim() });
  }
  if (
    input.kind === "redact" &&
    typeof input.code === "string" &&
    input.code.trim() &&
    input.payload !== undefined
  ) {
    measureContextPayload(input.payload);
    return Object.freeze({
      kind: "redact",
      code: input.code.trim(),
      payload: input.payload,
    });
  }
  return projectionContractFailure(
    "Context Projection policy returned an invalid decision.",
    "ContextProjectionPolicy.decide",
  );
}

function projectionContractFailure(message: string, path: string): never {
  return fail("context_projection_contract_invalid", message, path);
}
