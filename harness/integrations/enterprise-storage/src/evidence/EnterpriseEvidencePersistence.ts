import type { Evidence, EvidenceSensitivity } from "@agent-anything/context/evidence";
import type {
  EvidencePersistencePort,
  EvidencePersistenceResult,
} from "@agent-anything/context/persistence";
import type { ArtifactRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "@agent-anything/context/evidence";

export type EnterpriseRetentionPolicyRef = string;
export type EnterpriseAccessPolicyRef = string;

export interface EnterpriseEvidencePersistencePolicy {
  readonly retentionPolicyBySensitivity: Readonly<
    Record<EvidenceSensitivity, EnterpriseRetentionPolicyRef>
  >;
  readonly accessPolicyBySensitivity: Readonly<
    Record<EvidenceSensitivity, EnterpriseAccessPolicyRef>
  >;
  readonly maxEvidenceBytes: number;
}

export interface EnterpriseEvidenceCommitInput {
  readonly commitId: string;
  readonly evidence: Evidence;
  readonly contentLengthBytes: number;
  readonly workspaceId: string | null;
  readonly actorRef: string | null;
  readonly retentionPolicyRef: EnterpriseRetentionPolicyRef;
  readonly accessPolicyRef: EnterpriseAccessPolicyRef;
  readonly sensitivity: EvidenceSensitivity;
  readonly auditCorrelationId: string | null;
}

export interface EnterpriseEvidenceCommitReceipt {
  readonly commitId: string;
  readonly storageId: string;
  readonly evidenceRef: EvidenceRef;
  readonly artifactRef: ArtifactRef;
  readonly createdAt: string;
  readonly workspaceId: string | null;
  readonly actorRef: string | null;
  readonly retentionPolicyRef: EnterpriseRetentionPolicyRef;
  readonly accessPolicyRef: EnterpriseAccessPolicyRef;
  readonly sensitivity: EvidenceSensitivity;
  readonly auditCorrelationId: string | null;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export interface EnterpriseEvidenceFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type EnterpriseEvidenceCommitOutcome =
  | {
      readonly status: "committed";
      readonly receipt: EnterpriseEvidenceCommitReceipt;
    }
  | {
      readonly status: "not_committed";
      readonly failure: EnterpriseEvidenceFailure;
    }
  | {
      readonly status: "ambiguous";
      readonly reconciliationToken: string | null;
      readonly failure: EnterpriseEvidenceFailure;
    };

export interface EnterpriseEvidenceReconciliationInput {
  readonly commitId: string;
  readonly evidenceRef: EvidenceRef;
  readonly reconciliationToken: string | null;
}

export type EnterpriseEvidenceReconciliationOutcome =
  | {
      readonly status: "committed";
      readonly receipt: EnterpriseEvidenceCommitReceipt;
    }
  | {
      readonly status: "not_committed";
      readonly failure: EnterpriseEvidenceFailure;
    }
  | {
      readonly status: "unresolved";
      readonly reconciliationToken: string | null;
      readonly failure: EnterpriseEvidenceFailure;
    };

export interface EnterpriseEvidencePersistenceClient {
  commitEvidence(
    input: EnterpriseEvidenceCommitInput,
  ): Promise<EnterpriseEvidenceCommitOutcome>;
  reconcileEvidenceCommit(
    input: EnterpriseEvidenceReconciliationInput,
  ): Promise<EnterpriseEvidenceReconciliationOutcome>;
}

export interface CreateEnterpriseEvidencePersistenceAdapterInput {
  readonly client: EnterpriseEvidencePersistenceClient;
  readonly commitNamespace: string;
  readonly workspaceId?: string | null;
  readonly actorRef?: string | null;
  readonly auditCorrelationId?: string | null;
  readonly policy: EnterpriseEvidencePersistencePolicy;
}

interface PreparedEvidenceCommit {
  readonly canonicalEvidence: string;
  readonly input: EnterpriseEvidenceCommitInput;
}

interface PendingReconciliation {
  readonly operation: PreparedEvidenceCommit;
  readonly reconciliationToken: string | null;
}

interface InFlightPersistence {
  readonly canonicalEvidence: string;
  readonly result: Promise<EvidencePersistenceResult>;
}

const sensitivities: readonly EvidenceSensitivity[] = Object.freeze([
  "public",
  "private",
  "secret",
  "restricted",
]);

export class EnterpriseEvidencePersistenceAdapter implements EvidencePersistencePort {
  private readonly client: EnterpriseEvidencePersistenceClient;
  private readonly commitNamespace: string;
  private readonly workspaceId: string | null;
  private readonly actorRef: string | null;
  private readonly auditCorrelationId: string | null;
  private readonly policy: EnterpriseEvidencePersistencePolicy;
  private readonly pending = new Map<string, PendingReconciliation>();
  private readonly inFlight = new Map<string, InFlightPersistence>();

  constructor(input: CreateEnterpriseEvidencePersistenceAdapterInput) {
    this.client = input.client;
    this.commitNamespace = requiredText(input.commitNamespace, "commitNamespace");
    this.workspaceId = optionalText(input.workspaceId, "workspaceId");
    this.actorRef = optionalText(input.actorRef, "actorRef");
    this.auditCorrelationId = optionalText(
      input.auditCorrelationId,
      "auditCorrelationId",
    );
    this.policy = snapshotPolicy(input.policy);
  }

  async persistEvidence(evidence: Evidence): Promise<EvidencePersistenceResult> {
    let operation: PreparedEvidenceCommit;
    try {
      operation = prepareEvidenceCommit({
        evidence,
        commitNamespace: this.commitNamespace,
        workspaceId: this.workspaceId,
        actorRef: this.actorRef,
        auditCorrelationId: this.auditCorrelationId,
        policy: this.policy,
      });
    } catch (error) {
      return failed(
        "enterprise_evidence_invalid",
        safeMessage(error, "Evidence is invalid for enterprise persistence."),
        false,
      );
    }

    const commitId = operation.input.commitId;
    const active = this.inFlight.get(commitId);
    if (active !== undefined) {
      return active.canonicalEvidence === operation.canonicalEvidence
        ? active.result
        : failed(
            "enterprise_evidence_identity_conflict",
            "The same Evidence identity was reused with different content.",
            false,
          );
    }

    const pending = this.pending.get(commitId);
    if (
      pending !== undefined &&
      pending.operation.canonicalEvidence !== operation.canonicalEvidence
    ) {
      return failed(
        "enterprise_evidence_identity_conflict",
        "The same Evidence identity was reused with different content.",
        false,
      );
    }

    const result = (pending === undefined
      ? this.commit(operation)
      : this.reconcile(pending)
    ).finally(() => {
      this.inFlight.delete(commitId);
    });
    this.inFlight.set(commitId, {
      canonicalEvidence: operation.canonicalEvidence,
      result,
    });
    return result;
  }

  private async commit(
    operation: PreparedEvidenceCommit,
  ): Promise<EvidencePersistenceResult> {
    let outcome: EnterpriseEvidenceCommitOutcome;
    try {
      outcome = await this.client.commitEvidence(operation.input);
    } catch {
      return this.beginReconciliation(
        operation,
        null,
        "Enterprise Evidence commit settlement is ambiguous.",
      );
    }

    switch (outcome.status) {
      case "committed":
        return this.acceptReceipt(operation, outcome.receipt);
      case "not_committed":
        return mapFailure(outcome.failure);
      case "ambiguous":
        return this.beginReconciliation(
          operation,
          outcome.reconciliationToken,
          outcome.failure.message,
        );
    }
  }

  private async beginReconciliation(
    operation: PreparedEvidenceCommit,
    reconciliationToken: string | null,
    fallbackMessage: string,
  ): Promise<EvidencePersistenceResult> {
    const pending: PendingReconciliation = {
      operation,
      reconciliationToken,
    };
    this.pending.set(operation.input.commitId, pending);
    return this.reconcile(pending, fallbackMessage);
  }

  private async reconcile(
    pending: PendingReconciliation,
    fallbackMessage = "Enterprise Evidence commit remains ambiguous.",
  ): Promise<EvidencePersistenceResult> {
    const { operation } = pending;
    let outcome: EnterpriseEvidenceReconciliationOutcome;
    try {
      outcome = await this.client.reconcileEvidenceCommit({
        commitId: operation.input.commitId,
        evidenceRef: operation.input.evidence.id,
        reconciliationToken: pending.reconciliationToken,
      });
    } catch {
      return failed(
        "enterprise_evidence_commit_ambiguous",
        fallbackMessage,
        true,
        { commitId: operation.input.commitId },
      );
    }

    switch (outcome.status) {
      case "committed":
        return this.acceptReceipt(operation, outcome.receipt);
      case "not_committed":
        this.pending.delete(operation.input.commitId);
        return mapFailure(outcome.failure);
      case "unresolved":
        this.pending.set(operation.input.commitId, {
          operation,
          reconciliationToken: outcome.reconciliationToken,
        });
        return mapFailure(outcome.failure);
    }
  }

  private acceptReceipt(
    operation: PreparedEvidenceCommit,
    receipt: EnterpriseEvidenceCommitReceipt,
  ): EvidencePersistenceResult {
    try {
      validateReceipt(operation.input, receipt);
      this.pending.delete(operation.input.commitId);
      return {
        status: "stored",
        artifact: {
          storageId: receipt.storageId,
          evidenceRef: receipt.evidenceRef,
          artifactRef: receipt.artifactRef,
          createdAt: receipt.createdAt,
          metadata: Object.freeze({
            ...snapshotMetadata(receipt.safeMetadata, "receipt.safeMetadata"),
            adapter: "enterprise-evidence",
            commitId: receipt.commitId,
            retentionPolicyRef: receipt.retentionPolicyRef,
            accessPolicyRef: receipt.accessPolicyRef,
            sensitivity: receipt.sensitivity,
          }),
        },
      };
    } catch (error) {
      this.pending.set(operation.input.commitId, {
        operation,
        reconciliationToken: null,
      });
      return failed(
        "enterprise_evidence_receipt_invalid",
        safeMessage(error, "Enterprise Evidence receipt is invalid."),
        false,
        { commitId: operation.input.commitId },
      );
    }
  }
}

export function createEnterpriseEvidencePersistenceAdapter(
  input: CreateEnterpriseEvidencePersistenceAdapterInput,
): EvidencePersistencePort {
  return new EnterpriseEvidencePersistenceAdapter(input);
}

function prepareEvidenceCommit(input: {
  readonly evidence: Evidence;
  readonly commitNamespace: string;
  readonly workspaceId: string | null;
  readonly actorRef: string | null;
  readonly auditCorrelationId: string | null;
  readonly policy: EnterpriseEvidencePersistencePolicy;
}): PreparedEvidenceCommit {
  validateEvidenceIdentity(input.evidence);
  const evidence = snapshotJsonValue(input.evidence, "evidence") as unknown as Evidence;
  const canonicalEvidence = JSON.stringify(evidence);
  const contentLengthBytes = new TextEncoder().encode(canonicalEvidence).byteLength;
  if (contentLengthBytes > input.policy.maxEvidenceBytes) {
    throw new TypeError("Evidence exceeds the configured enterprise persistence limit.");
  }
  const sensitivity = input.evidence.sensitivity;
  const retentionPolicyRef =
    input.policy.retentionPolicyBySensitivity[sensitivity];
  const accessPolicyRef = input.policy.accessPolicyBySensitivity[sensitivity];
  return Object.freeze({
    canonicalEvidence,
    input: Object.freeze({
      commitId: [
        "enterprise-evidence",
        encodeURIComponent(input.commitNamespace),
        encodeURIComponent(input.evidence.id),
      ].join(":"),
      evidence,
      contentLengthBytes,
      workspaceId: input.workspaceId,
      actorRef: input.actorRef,
      retentionPolicyRef,
      accessPolicyRef,
      sensitivity,
      auditCorrelationId: input.auditCorrelationId,
    }),
  });
}

function validateEvidenceIdentity(evidence: Evidence): void {
  if (evidence === null || typeof evidence !== "object") {
    throw new TypeError("Evidence must be an object.");
  }
  requiredText(evidence.id, "evidence.id");
  requiredText(evidence.summary, "evidence.summary");
  if (!sensitivities.includes(evidence.sensitivity)) {
    throw new TypeError("Evidence sensitivity is invalid.");
  }
  if (
    evidence.source === null ||
    typeof evidence.source !== "object"
  ) {
    throw new TypeError("Evidence source is invalid.");
  }
  requiredText(evidence.source.owner, "evidence.source.owner");
  requiredText(evidence.source.kind, "evidence.source.kind");
  requiredText(evidence.source.id, "evidence.source.id");
  optionalText(evidence.source.revision, "evidence.source.revision");
  snapshotMetadata(evidence.source.metadata, "evidence.source.metadata");
}

function validateReceipt(
  input: EnterpriseEvidenceCommitInput,
  receipt: EnterpriseEvidenceCommitReceipt,
): void {
  if (receipt === null || typeof receipt !== "object") {
    throw new TypeError("Enterprise Evidence receipt must be an object.");
  }
  if (
    receipt.commitId !== input.commitId ||
    receipt.evidenceRef !== input.evidence.id ||
    receipt.workspaceId !== input.workspaceId ||
    receipt.actorRef !== input.actorRef ||
    receipt.retentionPolicyRef !== input.retentionPolicyRef ||
    receipt.accessPolicyRef !== input.accessPolicyRef ||
    receipt.sensitivity !== input.sensitivity ||
    receipt.auditCorrelationId !== input.auditCorrelationId
  ) {
    throw new TypeError("Enterprise Evidence receipt does not match the commit.");
  }
  requiredText(receipt.storageId, "receipt.storageId");
  requiredText(receipt.artifactRef, "receipt.artifactRef");
  requiredText(receipt.createdAt, "receipt.createdAt");
  if (Number.isNaN(Date.parse(receipt.createdAt))) {
    throw new TypeError("Enterprise Evidence receipt creation time is invalid.");
  }
  snapshotMetadata(receipt.safeMetadata, "receipt.safeMetadata");
}

function snapshotPolicy(
  policy: EnterpriseEvidencePersistencePolicy,
): EnterpriseEvidencePersistencePolicy {
  if (
    !Number.isSafeInteger(policy.maxEvidenceBytes) ||
    policy.maxEvidenceBytes <= 0
  ) {
    throw new TypeError("Enterprise Evidence maxEvidenceBytes must be positive.");
  }
  const retentionPolicyBySensitivity = {} as Record<
    EvidenceSensitivity,
    EnterpriseRetentionPolicyRef
  >;
  const accessPolicyBySensitivity = {} as Record<
    EvidenceSensitivity,
    EnterpriseAccessPolicyRef
  >;
  for (const sensitivity of sensitivities) {
    retentionPolicyBySensitivity[sensitivity] = requiredText(
      policy.retentionPolicyBySensitivity[sensitivity],
      `retentionPolicyBySensitivity.${sensitivity}`,
    );
    accessPolicyBySensitivity[sensitivity] = requiredText(
      policy.accessPolicyBySensitivity[sensitivity],
      `accessPolicyBySensitivity.${sensitivity}`,
    );
  }
  return Object.freeze({
    retentionPolicyBySensitivity: Object.freeze(retentionPolicyBySensitivity),
    accessPolicyBySensitivity: Object.freeze(accessPolicyBySensitivity),
    maxEvidenceBytes: policy.maxEvidenceBytes,
  });
}

function snapshotMetadata(value: Readonly<Record<string, unknown>>, field: string): Readonly<Record<string, unknown>> {
  const snapshot = snapshotJsonValue(value, field);
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new TypeError(`${field} must be a plain object.`);
  }
  return snapshot as Readonly<Record<string, unknown>>;
}

function snapshotJsonValue(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) =>
          snapshotJsonValue(item, `${path}[${index}]`, ancestors)
        ),
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${path} must contain only plain objects.`);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        throw new TypeError(`${path}.${key} is not a plain data property.`);
      }
      snapshot[key] = snapshotJsonValue(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      );
    }
    return Object.freeze(snapshot);
  } finally {
    ancestors.delete(value);
  }
}

function mapFailure(
  failure: EnterpriseEvidenceFailure,
): EvidencePersistenceResult {
  try {
    return failed(
      requiredText(failure.code, "failure.code"),
      requiredText(failure.message, "failure.message"),
      failure.retryable === true,
      snapshotMetadata(failure.metadata, "failure.metadata"),
    );
  } catch {
    return failed(
      "enterprise_evidence_failure_invalid",
      "Enterprise Evidence client returned an invalid failure.",
      false,
    );
  }
}

function failed(
  code: string,
  message: string,
  retryable: boolean,
  metadata: Readonly<Record<string, unknown>> = {},
): EvidencePersistenceResult {
  return {
    status: "failed",
    error: {
      code,
      message,
      retryable,
      metadata: Object.freeze({ ...metadata }),
    },
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text.`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field);
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof TypeError ? error.message : fallback;
}
