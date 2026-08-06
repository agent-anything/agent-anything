
import type {
  PluginContributionAdmission,
  PluginAdmissionSnapshot,
} from "../admission/PluginAdmission.js";
import {
  assertCanonicalDataArray,
  assertExactDataProperties,
  assertPlainRecord,
  compareStrings,
  createPluginContractFingerprint,
  validatePluginDateTime,
  validatePluginText,
  validatePluginToken,
  validatePositiveSafeInteger,
  validateSha256Fingerprint,
} from "../manifest/PluginData.js";
import {
  contributionIdentityKey,
  findPluginContribution,
  type PluginContributionDescriptor,
  type PluginContributionKind,
} from "../manifest/PluginContribution.js";
import type { PluginManifestSnapshot } from "../manifest/PluginManifest.js";

export interface PluginContributionSourceRef {
  readonly kind: "plugin";
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly activationEpoch: number;
  readonly capabilityId: string;
}

export interface PluginContributionActivationCandidate {
  readonly kind: PluginContributionKind;
  readonly contributionId: string;
  readonly descriptorFingerprint: string;
  readonly descriptor: PluginContributionDescriptor;
  readonly admission: PluginContributionAdmission;
  readonly source: PluginContributionSourceRef;
}

export interface PluginOwnerActivationRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestFingerprint: string;
  readonly packageDigest: string;
  readonly admissionFingerprint: string;
  readonly proposedActivationEpoch: number;
  readonly contributions: readonly PluginContributionActivationCandidate[];
}

interface PluginOwnerReceiptBase {
  readonly kind: PluginContributionKind;
  readonly contributionId: string;
  readonly descriptorFingerprint: string;
  readonly source: PluginContributionSourceRef;
}

export interface PluginToolOwnerReceipt extends PluginOwnerReceiptBase {
  readonly kind: "tool";
  readonly localToolName: string;
  readonly toolRegistrationFingerprint: string;
  readonly toolRegistrationSnapshotId: string;
  readonly actionRegistrationFingerprint: string;
  readonly actionRegistrationSnapshotId: string;
  readonly enforcement: "sandbox-execution-gateway";
}

export interface PluginMcpOwnerReceipt extends PluginOwnerReceiptBase {
  readonly kind: "mcpServer";
  readonly serverId: string;
  readonly mcpRegistrationFingerprint: string;
}

export interface PluginPolicyOwnerReceipt extends PluginOwnerReceiptBase {
  readonly kind: "policy";
  readonly policyProviderId: string;
  readonly policyRegistrationFingerprint: string;
  readonly managedTrustFingerprint: string;
  readonly composition: "restrictive";
}

export type PluginOwnerActivationReceipt =
  | PluginToolOwnerReceipt
  | PluginMcpOwnerReceipt
  | PluginPolicyOwnerReceipt;

export interface PluginOwnerActivatedResult {
  readonly status: "activated";
  readonly requestId: string;
  readonly pluginId: string;
  readonly manifestFingerprint: string;
  readonly admissionFingerprint: string;
  readonly activationEpoch: number;
  readonly ownerCommitId: string;
  readonly receipts: readonly PluginOwnerActivationReceipt[];
  readonly activatedAt: string;
}

export interface PluginOwnerRejectedResult {
  readonly status: "rejected";
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

export type PluginOwnerActivationResult =
  | PluginOwnerActivatedResult
  | PluginOwnerRejectedResult;

export interface PluginActivationSnapshot {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly activationRequestId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestFingerprint: string;
  readonly packageDigest: string;
  readonly admissionFingerprint: string;
  readonly activationEpoch: number;
  readonly ownerCommitId: string;
  readonly receipts: readonly PluginOwnerActivationReceipt[];
  readonly activatedAt: string;
}

export interface PluginActivationLookup {
  readonly pluginId: string;
  readonly manifestFingerprint: string;
  readonly activationEpoch: number;
}

export interface PluginContributionActivationLookup
  extends PluginActivationLookup {
  readonly kind: PluginContributionKind;
  readonly contributionId: string;
  readonly descriptorFingerprint: string;
}

export interface PluginActivationResolver {
  resolveActivation(input: PluginActivationLookup): PluginActivationSnapshot | null;
  resolveContributionActivation(
    input: PluginContributionActivationLookup,
  ): PluginOwnerActivationReceipt | null;
}

export interface PluginOwnerDeactivationRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly activation: PluginActivationSnapshot;
}

export interface PluginOwnerDeactivatedResult {
  readonly status: "deactivated";
  readonly requestId: string;
  readonly activationId: string;
  readonly ownerCommitId: string;
  readonly deactivatedAt: string;
}

export type PluginOwnerDeactivationResult =
  | PluginOwnerDeactivatedResult
  | PluginOwnerRejectedResult;

export interface PluginContributionActivationPort {
  activate(
    request: PluginOwnerActivationRequest,
  ): Promise<PluginOwnerActivationResult>;
  deactivate(
    request: PluginOwnerDeactivationRequest,
  ): Promise<PluginOwnerDeactivationResult>;
}

export class PluginActivationContractError extends TypeError {
  constructor(
    readonly code:
      | "plugin_activation_request_invalid"
      | "plugin_activation_result_invalid"
      | "plugin_activation_receipt_invalid"
      | "plugin_deactivation_result_invalid",
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PluginActivationContractError";
  }
}

export function createPluginOwnerActivationRequest(input: {
  readonly requestId: string;
  readonly manifest: PluginManifestSnapshot;
  readonly admission: PluginAdmissionSnapshot;
  readonly proposedActivationEpoch: number;
}): PluginOwnerActivationRequest {
  try {
    return createPluginOwnerActivationRequestUnchecked(input);
  } catch (error) {
    throw normalizeActivationContractError(
      error,
      "plugin_activation_request_invalid",
      "Plugin owner activation request is invalid.",
      "activationRequest",
    );
  }
}

function createPluginOwnerActivationRequestUnchecked(input: {
  readonly requestId: string;
  readonly manifest: PluginManifestSnapshot;
  readonly admission: PluginAdmissionSnapshot;
  readonly proposedActivationEpoch: number;
}): PluginOwnerActivationRequest {
  if (
    input.admission.outcome !== "admitted" ||
    input.admission.manifestFingerprint !== input.manifest.manifestFingerprint
  ) {
    activationInvalid(
      "plugin_activation_request_invalid",
      "Plugin activation requires an admitted decision for the exact manifest.",
      "activationRequest.admission",
    );
  }
  const proposedActivationEpoch = validatePositiveSafeInteger(
    input.proposedActivationEpoch,
    "activationRequest.proposedActivationEpoch",
  );
  const contributions = input.admission.contributions.map((admission) => {
    const descriptor = findPluginContribution(
      input.manifest.contributions,
      admission.kind,
      admission.contributionId,
    );
    if (
      descriptor === null ||
      descriptor.descriptorFingerprint !== admission.descriptorFingerprint
    ) {
      activationInvalid(
        "plugin_activation_request_invalid",
        "Admitted Plugin contribution no longer matches the manifest.",
        "activationRequest.contributions",
      );
    }
    return Object.freeze({
      kind: admission.kind,
      contributionId: admission.contributionId,
      descriptorFingerprint: admission.descriptorFingerprint,
      descriptor,
      admission,
      source: createPluginContributionSourceRef({
        pluginId: input.manifest.id,
        manifestFingerprint: input.manifest.manifestFingerprint,
        activationEpoch: proposedActivationEpoch,
        contributionId: admission.contributionId,
      }),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    requestId: validatePluginToken(
      input.requestId,
      "activationRequest.requestId",
      1_024,
    ),
    pluginId: input.manifest.id,
    pluginVersion: input.manifest.version,
    manifestFingerprint: input.manifest.manifestFingerprint,
    packageDigest: input.manifest.provenance.packageDigest,
    admissionFingerprint: input.admission.admissionFingerprint,
    proposedActivationEpoch,
    contributions: Object.freeze(contributions),
  });
}

export function createPluginContributionSourceRef(input: {
  readonly pluginId: string;
  readonly manifestFingerprint: string;
  readonly activationEpoch: number;
  readonly contributionId: string;
}): PluginContributionSourceRef {
  return Object.freeze({
    kind: "plugin" as const,
    sourceId: validatePluginToken(input.pluginId, "source.sourceId"),
    sourceRevision: validateSha256Fingerprint(
      input.manifestFingerprint,
      "source.sourceRevision",
    ),
    activationEpoch: validatePositiveSafeInteger(
      input.activationEpoch,
      "source.activationEpoch",
    ),
    capabilityId: validatePluginToken(
      input.contributionId,
      "source.capabilityId",
    ),
  });
}

export function settlePluginOwnerActivationResult(
  input: unknown,
  request: PluginOwnerActivationRequest,
): PluginActivationSnapshot | PluginOwnerRejectedResult {
  try {
    return settlePluginOwnerActivationResultUnchecked(input, request);
  } catch (error) {
    throw normalizeActivationContractError(
      error,
      "plugin_activation_result_invalid",
      "Plugin owner activation result is invalid.",
      "activationResult",
    );
  }
}

function settlePluginOwnerActivationResultUnchecked(
  input: unknown,
  request: PluginOwnerActivationRequest,
): PluginActivationSnapshot | PluginOwnerRejectedResult {
  assertPlainRecord(input, "activationResult");
  if (input.status === "rejected") {
    return snapshotOwnerRejection(input, request.requestId, "activationResult");
  }
  if (input.status !== "activated") {
    activationInvalid(
      "plugin_activation_result_invalid",
      "Plugin owner activation result status is invalid.",
      "activationResult.status",
    );
  }
  assertExactDataProperties(
    input,
    new Set([
      "status",
      "requestId",
      "pluginId",
      "manifestFingerprint",
      "admissionFingerprint",
      "activationEpoch",
      "ownerCommitId",
      "receipts",
      "activatedAt",
    ]),
    new Set(),
    "activationResult",
  );
  assertCorrelation(
    input.requestId,
    request.requestId,
    "activationResult.requestId",
  );
  assertCorrelation(
    input.pluginId,
    request.pluginId,
    "activationResult.pluginId",
  );
  assertCorrelation(
    input.manifestFingerprint,
    request.manifestFingerprint,
    "activationResult.manifestFingerprint",
  );
  assertCorrelation(
    input.admissionFingerprint,
    request.admissionFingerprint,
    "activationResult.admissionFingerprint",
  );
  if (input.activationEpoch !== request.proposedActivationEpoch) {
    activationInvalid(
      "plugin_activation_result_invalid",
      "Plugin owner activation result epoch is stale.",
      "activationResult.activationEpoch",
    );
  }
  const receipts = snapshotOwnerReceipts(input.receipts, request);
  const fields = Object.freeze({
    schemaVersion: 1 as const,
    activationRequestId: request.requestId,
    pluginId: request.pluginId,
    pluginVersion: request.pluginVersion,
    manifestFingerprint: request.manifestFingerprint,
    packageDigest: request.packageDigest,
    admissionFingerprint: request.admissionFingerprint,
    activationEpoch: request.proposedActivationEpoch,
    ownerCommitId: validatePluginToken(
      input.ownerCommitId,
      "activationResult.ownerCommitId",
      1_024,
    ),
    receipts,
    activatedAt: validatePluginDateTime(
      input.activatedAt,
      "activationResult.activatedAt",
    ),
  });
  return Object.freeze({
    ...fields,
    activationId: createPluginContractFingerprint(
      "agent-anything.plugin-activation.v1",
      fields,
    ),
  });
}

export function createPluginOwnerDeactivationRequest(input: {
  readonly requestId: string;
  readonly activation: PluginActivationSnapshot;
}): PluginOwnerDeactivationRequest {
  try {
    return Object.freeze({
      schemaVersion: 1 as const,
      requestId: validatePluginToken(
        input.requestId,
        "deactivationRequest.requestId",
        1_024,
      ),
      activation: input.activation,
    });
  } catch (error) {
    throw normalizeActivationContractError(
      error,
      "plugin_activation_request_invalid",
      "Plugin owner deactivation request is invalid.",
      "deactivationRequest",
    );
  }
}

export function settlePluginOwnerDeactivationResult(
  input: unknown,
  request: PluginOwnerDeactivationRequest,
): PluginOwnerDeactivatedResult | PluginOwnerRejectedResult {
  try {
    return settlePluginOwnerDeactivationResultUnchecked(input, request);
  } catch (error) {
    throw normalizeActivationContractError(
      error,
      "plugin_deactivation_result_invalid",
      "Plugin owner deactivation result is invalid.",
      "deactivationResult",
    );
  }
}

function settlePluginOwnerDeactivationResultUnchecked(
  input: unknown,
  request: PluginOwnerDeactivationRequest,
): PluginOwnerDeactivatedResult | PluginOwnerRejectedResult {
  assertPlainRecord(input, "deactivationResult");
  if (input.status === "rejected") {
    return snapshotOwnerRejection(
      input,
      request.requestId,
      "deactivationResult",
    );
  }
  if (input.status !== "deactivated") {
    activationInvalid(
      "plugin_deactivation_result_invalid",
      "Plugin owner deactivation result status is invalid.",
      "deactivationResult.status",
    );
  }
  assertExactDataProperties(
    input,
    new Set([
      "status",
      "requestId",
      "activationId",
      "ownerCommitId",
      "deactivatedAt",
    ]),
    new Set(),
    "deactivationResult",
  );
  assertCorrelation(
    input.requestId,
    request.requestId,
    "deactivationResult.requestId",
  );
  assertCorrelation(
    input.activationId,
    request.activation.activationId,
    "deactivationResult.activationId",
  );
  return Object.freeze({
    status: "deactivated" as const,
    requestId: request.requestId,
    activationId: request.activation.activationId,
    ownerCommitId: validatePluginToken(
      input.ownerCommitId,
      "deactivationResult.ownerCommitId",
      1_024,
    ),
    deactivatedAt: validatePluginDateTime(
      input.deactivatedAt,
      "deactivationResult.deactivatedAt",
    ),
  });
}

function snapshotOwnerReceipts(
  input: unknown,
  request: PluginOwnerActivationRequest,
): readonly PluginOwnerActivationReceipt[] {
  assertCanonicalDataArray(input, "activationResult.receipts");
  if (input.length !== request.contributions.length) {
    activationInvalid(
      "plugin_activation_receipt_invalid",
      "Plugin owner activation must return exactly one receipt per contribution.",
      "activationResult.receipts",
    );
  }
  const candidates = new Map(
    request.contributions.map((candidate) => [
      contributionIdentityKey(candidate),
      candidate,
    ]),
  );
  const seen = new Set<string>();
  const receipts = input.map((candidate, index) => {
    const path = `activationResult.receipts[${index}]`;
    assertPlainRecord(candidate, path);
    const kind = candidate.kind;
    if (kind !== "tool" && kind !== "mcpServer" && kind !== "policy") {
      receiptInvalid("Plugin owner receipt kind is invalid.", `${path}.kind`);
    }
    const contributionId = validatePluginToken(
      candidate.contributionId,
      `${path}.contributionId`,
    );
    const key = contributionIdentityKey({ kind, contributionId });
    if (seen.has(key)) {
      receiptInvalid("Plugin owner receipt is duplicated.", path);
    }
    seen.add(key);
    const activationCandidate = candidates.get(key);
    if (activationCandidate === undefined) {
      receiptInvalid(
        "Plugin owner receipt names an unadmitted contribution.",
        path,
      );
    }
    const descriptorFingerprint = validateSha256Fingerprint(
      candidate.descriptorFingerprint,
      `${path}.descriptorFingerprint`,
    );
    if (
      descriptorFingerprint !== activationCandidate.descriptorFingerprint
    ) {
      receiptInvalid(
        "Plugin owner receipt descriptor is stale.",
        `${path}.descriptorFingerprint`,
      );
    }
    const source = snapshotAndMatchSource(
      candidate.source,
      activationCandidate.source,
      `${path}.source`,
    );
    switch (kind) {
      case "tool":
        assertExactDataProperties(
          candidate,
          new Set([
            "kind",
            "contributionId",
            "descriptorFingerprint",
            "source",
            "localToolName",
            "toolRegistrationFingerprint",
            "toolRegistrationSnapshotId",
            "actionRegistrationFingerprint",
            "actionRegistrationSnapshotId",
            "enforcement",
          ]),
          new Set(),
          path,
        );
        if (candidate.enforcement !== "sandbox-execution-gateway") {
          receiptInvalid(
            "Plugin Tool receipt must prove SandboxExecutionGateway enforcement.",
            `${path}.enforcement`,
          );
        }
        return Object.freeze({
          kind,
          contributionId,
          descriptorFingerprint,
          source,
          localToolName: validatePluginToken(
            candidate.localToolName,
            `${path}.localToolName`,
          ),
          toolRegistrationFingerprint: receiptFingerprint(
            candidate.toolRegistrationFingerprint,
            `${path}.toolRegistrationFingerprint`,
          ),
          toolRegistrationSnapshotId: receiptFingerprint(
            candidate.toolRegistrationSnapshotId,
            `${path}.toolRegistrationSnapshotId`,
          ),
          actionRegistrationFingerprint: receiptFingerprint(
            candidate.actionRegistrationFingerprint,
            `${path}.actionRegistrationFingerprint`,
          ),
          actionRegistrationSnapshotId: receiptFingerprint(
            candidate.actionRegistrationSnapshotId,
            `${path}.actionRegistrationSnapshotId`,
          ),
          enforcement: "sandbox-execution-gateway" as const,
        });
      case "mcpServer":
        assertExactDataProperties(
          candidate,
          new Set([
            "kind",
            "contributionId",
            "descriptorFingerprint",
            "source",
            "serverId",
            "mcpRegistrationFingerprint",
          ]),
          new Set(),
          path,
        );
        return Object.freeze({
          kind,
          contributionId,
          descriptorFingerprint,
          source,
          serverId: validatePluginToken(
            candidate.serverId,
            `${path}.serverId`,
          ),
          mcpRegistrationFingerprint: receiptFingerprint(
            candidate.mcpRegistrationFingerprint,
            `${path}.mcpRegistrationFingerprint`,
          ),
        });
      case "policy": {
        assertExactDataProperties(
          candidate,
          new Set([
            "kind",
            "contributionId",
            "descriptorFingerprint",
            "source",
            "policyProviderId",
            "policyRegistrationFingerprint",
            "managedTrustFingerprint",
            "composition",
          ]),
          new Set(),
          path,
        );
        if (candidate.composition !== "restrictive") {
          receiptInvalid(
            "Plugin Policy receipt must prove restrictive composition.",
            `${path}.composition`,
          );
        }
        const managedTrust = activationCandidate.admission.kind === "policy"
          ? activationCandidate.admission.managedTrust
          : null;
        if (
          managedTrust === null ||
          candidate.managedTrustFingerprint !==
            managedTrust.configurationFingerprint
        ) {
          receiptInvalid(
            "Plugin Policy receipt does not match managed trust admission.",
            `${path}.managedTrustFingerprint`,
          );
        }
        return Object.freeze({
          kind,
          contributionId,
          descriptorFingerprint,
          source,
          policyProviderId: validatePluginToken(
            candidate.policyProviderId,
            `${path}.policyProviderId`,
          ),
          policyRegistrationFingerprint: receiptFingerprint(
            candidate.policyRegistrationFingerprint,
            `${path}.policyRegistrationFingerprint`,
          ),
          managedTrustFingerprint: receiptFingerprint(
            candidate.managedTrustFingerprint,
            `${path}.managedTrustFingerprint`,
          ),
          composition: "restrictive" as const,
        });
      }
    }
  });
  if (seen.size !== candidates.size) {
    receiptInvalid(
      "Plugin owner activation receipt set is incomplete.",
      "activationResult.receipts",
    );
  }
  receipts.sort((left, right) =>
    compareStrings(
      contributionIdentityKey(left),
      contributionIdentityKey(right),
    )
  );
  return Object.freeze(receipts);
}

function snapshotAndMatchSource(
  input: unknown,
  expected: PluginContributionSourceRef,
  path: string,
): PluginContributionSourceRef {
  assertPlainRecord(input, path);
  assertExactDataProperties(
    input,
    new Set([
      "kind",
      "sourceId",
      "sourceRevision",
      "activationEpoch",
      "capabilityId",
    ]),
    new Set(),
    path,
  );
  if (input.kind !== "plugin") {
    receiptInvalid("Plugin owner receipt source kind is invalid.", `${path}.kind`);
  }
  const source = createPluginContributionSourceRef({
    pluginId: input.sourceId as string,
    manifestFingerprint: input.sourceRevision as string,
    activationEpoch: input.activationEpoch as number,
    contributionId: input.capabilityId as string,
  });
  if (
    source.sourceId !== expected.sourceId ||
    source.sourceRevision !== expected.sourceRevision ||
    source.activationEpoch !== expected.activationEpoch ||
    source.capabilityId !== expected.capabilityId
  ) {
    receiptInvalid("Plugin owner receipt source is stale.", path);
  }
  return source;
}

function snapshotOwnerRejection(
  input: Record<string, unknown>,
  requestId: string,
  path: string,
): PluginOwnerRejectedResult {
  assertExactDataProperties(
    input,
    new Set(["status", "requestId", "code", "message"]),
    new Set(),
    path,
  );
  assertCorrelation(input.requestId, requestId, `${path}.requestId`);
  return Object.freeze({
    status: "rejected" as const,
    requestId,
    code: validatePluginToken(input.code, `${path}.code`),
    message: validatePluginText(input.message, `${path}.message`, 4_096),
  });
}

function receiptFingerprint(input: unknown, path: string): string {
  try {
    return validateSha256Fingerprint(input, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid receipt.";
    receiptInvalid(message, path);
  }
}

function assertCorrelation(
  actual: unknown,
  expected: string,
  path: string,
): void {
  if (actual !== expected) {
    activationInvalid(
      path.startsWith("deactivation")
        ? "plugin_deactivation_result_invalid"
        : "plugin_activation_result_invalid",
      `${path} does not match the request.`,
      path,
    );
  }
}

function activationInvalid(
  code: PluginActivationContractError["code"],
  message: string,
  path: string,
): never {
  throw new PluginActivationContractError(code, message, path);
}

function receiptInvalid(message: string, path: string): never {
  activationInvalid("plugin_activation_receipt_invalid", message, path);
}

function normalizeActivationContractError(
  error: unknown,
  code: PluginActivationContractError["code"],
  fallbackMessage: string,
  fallbackPath: string,
): PluginActivationContractError {
  if (error instanceof PluginActivationContractError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  const match = message.match(
    /(?:activationRequest|activationResult|deactivationRequest|deactivationResult|source)(?:\.[A-Za-z0-9_[\].-]+)?/,
  );
  return new PluginActivationContractError(
    code,
    message,
    match?.[0] ?? fallbackPath,
  );
}
