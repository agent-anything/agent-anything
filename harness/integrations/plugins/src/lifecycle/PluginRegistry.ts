import { randomUUID } from "node:crypto";
import { gt } from "semver";

import {
  createPluginAdmissionSnapshot,
  type PluginAdmissionInput,
  type PluginAdmissionSnapshot,
} from "../admission/PluginAdmission.js";
import {
  createPluginOwnerActivationRequest,
  createPluginOwnerDeactivationRequest,
  settlePluginOwnerActivationResult,
  settlePluginOwnerDeactivationResult,
  PluginActivationContractError,
  type PluginActivationLookup,
  type PluginActivationResolver,
  type PluginActivationSnapshot,
  type PluginContributionActivationLookup,
  type PluginContributionActivationPort,
  type PluginOwnerActivationReceipt,
  type PluginOwnerDeactivatedResult,
} from "../activation/PluginActivation.js";
import {
  assertExactDataProperties,
  assertPlainRecord,
  validatePluginDateTime,
  validatePluginToken,
  validatePositiveSafeInteger,
  validateSha256Fingerprint,
} from "../manifest/PluginData.js";
import {
  createPluginManifestSnapshot,
  snapshotPluginManifestEnvironment,
  validatePluginManifest,
  type PluginManifestEnvironment,
  type PluginManifestEnvironmentInput,
  type PluginManifestInput,
  type PluginManifestSnapshot,
  type PluginManifestValidationResult,
} from "../manifest/PluginManifest.js";
import {
  PluginRegistryError,
  type PluginRegistryErrorCode,
} from "./PluginRegistryError.js";

export interface PluginRegistryDependencies {
  readonly environment: PluginManifestEnvironmentInput;
  readonly activationPort?: PluginContributionActivationPort;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export type PluginEnablement = "disabled" | "enabled";

export interface PluginRecordSnapshot {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly manifest: PluginManifestSnapshot;
  readonly enablement: PluginEnablement;
  readonly admission: PluginAdmissionSnapshot | null;
  readonly activation: PluginActivationSnapshot | null;
  readonly stateRevision: number;
  readonly installedAt: string;
  readonly changedAt: string;
}

export interface PluginMutationTarget {
  readonly pluginId: string;
  readonly expectedManifestFingerprint: string;
  readonly expectedStateRevision: number;
}

export interface UpdatePluginInput extends PluginMutationTarget {
  readonly manifest: PluginManifestInput;
}

export type EnablePluginInput = PluginMutationTarget;
export type DisablePluginInput = PluginMutationTarget;

export interface RecordPluginAdmissionInput extends PluginMutationTarget {
  readonly admission: PluginAdmissionInput;
}

export interface RevokePluginAdmissionInput extends PluginMutationTarget {
  readonly expectedAdmissionFingerprint: string;
  readonly decisionId: string;
  readonly authorityId: string;
  readonly reason: string;
  readonly decidedAt: string;
}

export interface ActivatePluginInput extends PluginMutationTarget {
  readonly expectedAdmissionFingerprint: string;
}

export interface DeactivatePluginInput extends PluginMutationTarget {
  readonly expectedAdmissionFingerprint: string;
  readonly expectedActivationId: string;
  readonly expectedActivationEpoch: number;
}

type PluginOperation = "activate" | "deactivate" | "disable" | "revoke";

interface PluginRecord {
  readonly installationId: string;
  readonly installedAt: string;
  manifest: PluginManifestSnapshot;
  enablement: PluginEnablement;
  admission: PluginAdmissionSnapshot | null;
  activation: PluginActivationSnapshot | null;
  stateRevision: number;
  changedAt: string;
  nextActivationEpoch: number;
  pendingOperation: PluginOperation | null;
}

export class PluginRegistry implements PluginActivationResolver {
  private readonly records = new Map<string, PluginRecord>();
  private readonly packageFingerprints = new Map<string, string>();
  private readonly environment: PluginManifestEnvironment;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly dependencies: PluginRegistryDependencies) {
    if (dependencies === null || typeof dependencies !== "object") {
      throw new TypeError("Plugin Registry dependencies are required.");
    }
    this.environment = snapshotPluginManifestEnvironment(
      dependencies.environment,
    );
    if (
      dependencies.activationPort !== undefined &&
      (
        typeof dependencies.activationPort.activate !== "function" ||
        typeof dependencies.activationPort.deactivate !== "function"
      )
    ) {
      throw new TypeError(
        "Plugin activation port must implement activate and deactivate.",
      );
    }
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
  }

  validate(input: unknown): PluginManifestValidationResult {
    return validatePluginManifest(input, this.environment);
  }

  install(input: PluginManifestInput): PluginRecordSnapshot {
    const manifest = createPluginManifestSnapshot(input, this.environment);
    this.assertPackageIdentity(manifest);
    if (this.records.has(manifest.id)) {
      registryError(
        "plugin_duplicate_installation",
        `Plugin '${manifest.id}' is already installed.`,
        manifest.id,
      );
    }
    const now = this.nowIso();
    const record: PluginRecord = {
      installationId: this.nextId("Plugin installation"),
      installedAt: now,
      manifest,
      enablement: "disabled",
      admission: null,
      activation: null,
      stateRevision: 1,
      changedAt: now,
      nextActivationEpoch: 1,
      pendingOperation: null,
    };
    this.records.set(manifest.id, record);
    this.rememberPackageIdentity(manifest);
    return snapshotRecord(record);
  }

  update(input: UpdatePluginInput): PluginRecordSnapshot {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    if (record.activation !== null) {
      registryError(
        "plugin_state_invalid",
        "An active Plugin must be deactivated before update.",
        target.pluginId,
      );
    }
    const manifest = createPluginManifestSnapshot(
      input.manifest,
      this.environment,
    );
    if (manifest.id !== target.pluginId) {
      registryError(
        "plugin_update_invalid",
        "Plugin update cannot change Plugin identity.",
        target.pluginId,
      );
    }
    this.assertPackageIdentity(manifest);
    if (!gt(manifest.version, record.manifest.version)) {
      registryError(
        "plugin_update_invalid",
        "Plugin update must advance to a higher Semantic Version.",
        target.pluginId,
      );
    }
    record.manifest = manifest;
    record.admission = null;
    record.activation = null;
    this.publishMutation(record);
    this.rememberPackageIdentity(manifest);
    return snapshotRecord(record);
  }

  enable(input: EnablePluginInput): PluginRecordSnapshot {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    if (record.enablement === "enabled") {
      registryError(
        "plugin_state_invalid",
        `Plugin '${target.pluginId}' is already enabled.`,
        target.pluginId,
      );
    }
    record.enablement = "enabled";
    this.publishMutation(record);
    return snapshotRecord(record);
  }

  async disable(input: DisablePluginInput): Promise<PluginRecordSnapshot> {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    if (record.enablement === "disabled") {
      registryError(
        "plugin_state_invalid",
        `Plugin '${target.pluginId}' is already disabled.`,
        target.pluginId,
      );
    }
    this.beginOperation(record, "disable");
    try {
      let changedAt: string;
      if (record.activation !== null) {
        const settlement = await this.settleDeactivation(
          record,
          record.activation,
        );
        record.activation = null;
        changedAt = settlement.deactivatedAt;
      } else {
        changedAt = this.nowIso();
      }
      record.enablement = "disabled";
      this.publishMutation(record, changedAt);
      return snapshotRecord(record);
    } finally {
      this.endOperation(record, "disable");
    }
  }

  recordAdmission(
    input: RecordPluginAdmissionInput,
  ): PluginRecordSnapshot {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    if (record.enablement !== "enabled") {
      registryError(
        "plugin_state_invalid",
        "Plugin admission requires an enabled installation.",
        target.pluginId,
      );
    }
    if (record.activation !== null) {
      registryError(
        "plugin_state_invalid",
        "An active Plugin must be deactivated before admission changes.",
        target.pluginId,
      );
    }
    if (input.admission.outcome === "revoked") {
      registryError(
        "plugin_admission_invalid",
        "Use revokeAdmission to revoke a current Plugin admission.",
        target.pluginId,
      );
    }
    const admission = createPluginAdmissionSnapshot(
      input.admission,
      record.manifest,
    );
    if (admission.supersedesAdmissionFingerprint !== null) {
      registryError(
        "plugin_admission_invalid",
        "A non-revocation admission cannot supersede another decision.",
        target.pluginId,
      );
    }
    record.admission = admission;
    this.publishMutation(record);
    return snapshotRecord(record);
  }

  async revokeAdmission(
    input: RevokePluginAdmissionInput,
  ): Promise<PluginRecordSnapshot> {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    const currentAdmission = this.requireAdmission(
      record,
      input.expectedAdmissionFingerprint,
    );
    if (currentAdmission.outcome !== "admitted") {
      registryError(
        "plugin_state_invalid",
        "Only an admitted Plugin decision can be revoked.",
        target.pluginId,
      );
    }
    const revokedAdmission = createPluginAdmissionSnapshot(
      {
        decisionId: input.decisionId,
        authorityId: input.authorityId,
        manifestFingerprint: record.manifest.manifestFingerprint,
        outcome: "revoked",
        contributions: [],
        reason: input.reason,
        supersedesAdmissionFingerprint:
          currentAdmission.admissionFingerprint,
        decidedAt: input.decidedAt,
      },
      record.manifest,
    );
    this.beginOperation(record, "revoke");
    try {
      let changedAt = revokedAdmission.decidedAt;
      if (record.activation !== null) {
        const settlement = await this.settleDeactivation(
          record,
          record.activation,
        );
        record.activation = null;
        if (settlement.deactivatedAt > changedAt) {
          changedAt = settlement.deactivatedAt;
        }
      }
      record.admission = revokedAdmission;
      this.publishMutation(record, changedAt);
      return snapshotRecord(record);
    } finally {
      this.endOperation(record, "revoke");
    }
  }

  async activate(
    input: ActivatePluginInput,
  ): Promise<PluginActivationSnapshot> {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    if (record.enablement !== "enabled") {
      registryError(
        "plugin_state_invalid",
        "A disabled Plugin cannot activate contributions.",
        target.pluginId,
      );
    }
    if (record.activation !== null) {
      registryError(
        "plugin_state_invalid",
        `Plugin '${target.pluginId}' is already active.`,
        target.pluginId,
      );
    }
    const admission = this.requireAdmission(
      record,
      input.expectedAdmissionFingerprint,
    );
    if (admission.outcome !== "admitted") {
      registryError(
        "plugin_state_invalid",
        "Plugin activation requires an admitted Host decision.",
        target.pluginId,
      );
    }
    const port = this.requireActivationPort(target.pluginId);
    const request = createPluginOwnerActivationRequest({
      requestId: this.nextId("Plugin activation request"),
      manifest: record.manifest,
      admission,
      proposedActivationEpoch: record.nextActivationEpoch,
    });
    this.beginOperation(record, "activate");
    try {
      let rawResult: unknown;
      try {
        rawResult = await port.activate(request);
      } catch (error) {
        registryError(
          "plugin_activation_failed",
          "Plugin owner activation transaction failed.",
          target.pluginId,
          error,
        );
      }
      let settled;
      try {
        settled = settlePluginOwnerActivationResult(rawResult, request);
      } catch (error) {
        this.throwOwnerContractError(
          error,
          "Plugin owner activation result is invalid.",
          target.pluginId,
        );
      }
      if ("status" in settled) {
        registryError(
          "plugin_activation_rejected",
          `Plugin owner activation was rejected: ${settled.code}: ${settled.message}`,
          target.pluginId,
        );
      }
      record.activation = settled;
      record.nextActivationEpoch += 1;
      this.publishMutation(record, settled.activatedAt);
      return settled;
    } finally {
      this.endOperation(record, "activate");
    }
  }

  async deactivate(
    input: DeactivatePluginInput,
  ): Promise<PluginRecordSnapshot> {
    const target = snapshotMutationTarget(input);
    const record = this.requireCurrentRecord(target);
    this.assertNoOperation(record);
    const admission = this.requireAdmission(
      record,
      input.expectedAdmissionFingerprint,
    );
    const activation = this.requireActivation(
      record,
      input.expectedActivationId,
      input.expectedActivationEpoch,
    );
    if (
      activation.admissionFingerprint !== admission.admissionFingerprint
    ) {
      registryError(
        "plugin_state_stale",
        "Plugin activation does not belong to the expected admission.",
        target.pluginId,
      );
    }
    this.beginOperation(record, "deactivate");
    try {
      const settlement = await this.settleDeactivation(record, activation);
      record.activation = null;
      this.publishMutation(record, settlement.deactivatedAt);
      return snapshotRecord(record);
    } finally {
      this.endOperation(record, "deactivate");
    }
  }

  get(pluginId: string): PluginRecordSnapshot | null {
    const record = this.records.get(pluginId);
    return record === undefined ? null : snapshotRecord(record);
  }

  list(): readonly PluginRecordSnapshot[] {
    return Object.freeze(
      [...this.records.values()]
        .sort((left, right) =>
          left.manifest.id < right.manifest.id
            ? -1
            : left.manifest.id > right.manifest.id
            ? 1
            : 0
        )
        .map(snapshotRecord),
    );
  }

  getActive(pluginId: string): PluginActivationSnapshot | null {
    return this.records.get(pluginId)?.activation ?? null;
  }

  listActive(): readonly PluginActivationSnapshot[] {
    return Object.freeze(
      this.list()
        .map((record) => record.activation)
        .filter(
          (activation): activation is PluginActivationSnapshot =>
            activation !== null,
        ),
    );
  }

  resolveActivation(
    input: PluginActivationLookup,
  ): PluginActivationSnapshot | null {
    const lookup = snapshotActivationLookup(input);
    if (lookup === null) return null;
    const active = this.records.get(lookup.pluginId)?.activation;
    if (
      active === undefined ||
      active === null ||
      active.manifestFingerprint !== lookup.manifestFingerprint ||
      active.activationEpoch !== lookup.activationEpoch
    ) {
      return null;
    }
    return active;
  }

  resolveContributionActivation(
    input: PluginContributionActivationLookup,
  ): PluginOwnerActivationReceipt | null {
    const lookup = snapshotContributionActivationLookup(input);
    if (lookup === null) return null;
    const activation = this.resolveActivation({
      pluginId: lookup.pluginId,
      manifestFingerprint: lookup.manifestFingerprint,
      activationEpoch: lookup.activationEpoch,
    });
    if (activation === null) return null;
    return activation.receipts.find(
      (receipt) =>
        receipt.kind === lookup.kind &&
        receipt.contributionId === lookup.contributionId &&
        receipt.descriptorFingerprint === lookup.descriptorFingerprint,
    ) ?? null;
  }

  private requireCurrentRecord(input: PluginMutationTarget): PluginRecord {
    const record = this.records.get(input.pluginId);
    if (record === undefined) {
      registryError(
        "plugin_not_found",
        `Plugin '${input.pluginId}' is not installed.`,
        input.pluginId,
      );
    }
    if (
      record.manifest.manifestFingerprint !==
        input.expectedManifestFingerprint ||
      record.stateRevision !== input.expectedStateRevision
    ) {
      registryError(
        "plugin_state_stale",
        `Plugin '${input.pluginId}' mutation target is stale.`,
        input.pluginId,
      );
    }
    return record;
  }

  private requireAdmission(
    record: PluginRecord,
    expectedFingerprintInput: unknown,
  ): PluginAdmissionSnapshot {
    const expectedFingerprint = validateSha256Fingerprint(
      expectedFingerprintInput,
      "expectedAdmissionFingerprint",
    );
    if (
      record.admission === null ||
      record.admission.admissionFingerprint !== expectedFingerprint
    ) {
      registryError(
        "plugin_state_stale",
        "Plugin admission target is stale or unavailable.",
        record.manifest.id,
      );
    }
    return record.admission;
  }

  private requireActivation(
    record: PluginRecord,
    expectedActivationIdInput: unknown,
    expectedActivationEpochInput: unknown,
  ): PluginActivationSnapshot {
    const expectedActivationId = validateSha256Fingerprint(
      expectedActivationIdInput,
      "expectedActivationId",
    );
    const expectedActivationEpoch = validatePositiveSafeInteger(
      expectedActivationEpochInput,
      "expectedActivationEpoch",
    );
    if (
      record.activation === null ||
      record.activation.activationId !== expectedActivationId ||
      record.activation.activationEpoch !== expectedActivationEpoch
    ) {
      registryError(
        "plugin_state_stale",
        "Plugin activation target is stale or unavailable.",
        record.manifest.id,
      );
    }
    return record.activation;
  }

  private requireActivationPort(
    pluginId: string,
  ): PluginContributionActivationPort {
    if (this.dependencies.activationPort === undefined) {
      registryError(
        "plugin_activation_unavailable",
        "Trusted Host Plugin activation composition is unavailable.",
        pluginId,
      );
    }
    return this.dependencies.activationPort;
  }

  private async settleDeactivation(
    record: PluginRecord,
    activation: PluginActivationSnapshot,
  ): Promise<PluginOwnerDeactivatedResult> {
    const port = this.requireActivationPort(record.manifest.id);
    const request = createPluginOwnerDeactivationRequest({
      requestId: this.nextId("Plugin deactivation request"),
      activation,
    });
    let rawResult: unknown;
    try {
      rawResult = await port.deactivate(request);
    } catch (error) {
      registryError(
        "plugin_deactivation_failed",
        "Plugin owner deactivation transaction failed.",
        record.manifest.id,
        error,
      );
    }
    let settled;
    try {
      settled = settlePluginOwnerDeactivationResult(rawResult, request);
    } catch (error) {
      this.throwOwnerContractError(
        error,
        "Plugin owner deactivation result is invalid.",
        record.manifest.id,
      );
    }
    if (settled.status === "rejected") {
      registryError(
        "plugin_deactivation_rejected",
        `Plugin owner deactivation was rejected: ${settled.code}: ${settled.message}`,
        record.manifest.id,
      );
    }
    return settled;
  }

  private assertPackageIdentity(manifest: PluginManifestSnapshot): void {
    const remembered = this.packageFingerprints.get(packageIdentityKey(manifest));
    if (
      remembered !== undefined &&
      remembered !== manifest.manifestFingerprint
    ) {
      registryError(
        "plugin_package_identity_conflict",
        `Plugin '${manifest.id}@${manifest.version}' identifies different package content.`,
        manifest.id,
      );
    }
  }

  private rememberPackageIdentity(manifest: PluginManifestSnapshot): void {
    this.packageFingerprints.set(
      packageIdentityKey(manifest),
      manifest.manifestFingerprint,
    );
  }

  private assertNoOperation(record: PluginRecord): void {
    if (record.pendingOperation !== null) {
      registryError(
        "plugin_operation_in_progress",
        `Plugin '${record.manifest.id}' has a pending '${record.pendingOperation}' operation.`,
        record.manifest.id,
      );
    }
  }

  private beginOperation(
    record: PluginRecord,
    operation: PluginOperation,
  ): void {
    this.assertNoOperation(record);
    record.pendingOperation = operation;
  }

  private endOperation(
    record: PluginRecord,
    operation: PluginOperation,
  ): void {
    if (record.pendingOperation === operation) {
      record.pendingOperation = null;
    }
  }

  private publishMutation(
    record: PluginRecord,
    changedAt = this.nowIso(),
  ): void {
    record.stateRevision += 1;
    record.changedAt = changedAt;
  }

  private throwOwnerContractError(
    error: unknown,
    message: string,
    pluginId: string,
  ): never {
    const cause = error instanceof PluginActivationContractError
      ? error
      : new TypeError(message, { cause: error });
    registryError(
      "plugin_owner_result_invalid",
      message,
      pluginId,
      cause,
    );
  }

  private nowIso(): string {
    let date: Date;
    try {
      date = this.now();
    } catch (error) {
      throw new TypeError("Plugin Registry clock failed.", { cause: error });
    }
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new TypeError("Plugin Registry clock returned an invalid Date.");
    }
    return validatePluginDateTime(date.toISOString(), "clock");
  }

  private nextId(label: string): string {
    let id: string;
    try {
      id = this.createId();
    } catch (error) {
      throw new TypeError(`${label} id allocation failed.`, { cause: error });
    }
    return validatePluginToken(id, `${label}.id`, 1_024);
  }
}

function snapshotMutationTarget(input: PluginMutationTarget): PluginMutationTarget {
  return Object.freeze({
    pluginId: validatePluginToken(input.pluginId, "pluginId"),
    expectedManifestFingerprint: validateSha256Fingerprint(
      input.expectedManifestFingerprint,
      "expectedManifestFingerprint",
    ),
    expectedStateRevision: validatePositiveSafeInteger(
      input.expectedStateRevision,
      "expectedStateRevision",
    ),
  });
}

function snapshotActivationLookup(
  input: unknown,
): PluginActivationLookup | null {
  try {
    assertPlainRecord(input, "activationLookup");
    assertExactDataProperties(
      input,
      new Set(["pluginId", "manifestFingerprint", "activationEpoch"]),
      new Set(),
      "activationLookup",
    );
    return Object.freeze({
      pluginId: validatePluginToken(input.pluginId, "activationLookup.pluginId"),
      manifestFingerprint: validateSha256Fingerprint(
        input.manifestFingerprint,
        "activationLookup.manifestFingerprint",
      ),
      activationEpoch: validatePositiveSafeInteger(
        input.activationEpoch,
        "activationLookup.activationEpoch",
      ),
    });
  } catch {
    return null;
  }
}

function snapshotContributionActivationLookup(
  input: unknown,
): PluginContributionActivationLookup | null {
  try {
    assertPlainRecord(input, "contributionActivationLookup");
    assertExactDataProperties(
      input,
      new Set([
        "pluginId",
        "manifestFingerprint",
        "activationEpoch",
        "kind",
        "contributionId",
        "descriptorFingerprint",
      ]),
      new Set(),
      "contributionActivationLookup",
    );
    if (
      input.kind !== "tool" &&
      input.kind !== "mcpServer" &&
      input.kind !== "policy"
    ) {
      return null;
    }
    return Object.freeze({
      pluginId: validatePluginToken(
        input.pluginId,
        "contributionActivationLookup.pluginId",
      ),
      manifestFingerprint: validateSha256Fingerprint(
        input.manifestFingerprint,
        "contributionActivationLookup.manifestFingerprint",
      ),
      activationEpoch: validatePositiveSafeInteger(
        input.activationEpoch,
        "contributionActivationLookup.activationEpoch",
      ),
      kind: input.kind,
      contributionId: validatePluginToken(
        input.contributionId,
        "contributionActivationLookup.contributionId",
      ),
      descriptorFingerprint: validateSha256Fingerprint(
        input.descriptorFingerprint,
        "contributionActivationLookup.descriptorFingerprint",
      ),
    });
  } catch {
    return null;
  }
}

function snapshotRecord(record: PluginRecord): PluginRecordSnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    installationId: record.installationId,
    manifest: record.manifest,
    enablement: record.enablement,
    admission: record.admission,
    activation: record.activation,
    stateRevision: record.stateRevision,
    installedAt: record.installedAt,
    changedAt: record.changedAt,
  });
}

function packageIdentityKey(manifest: PluginManifestSnapshot): string {
  return `${manifest.id}\u0000${manifest.version}`;
}

function registryError(
  code: PluginRegistryErrorCode,
  message: string,
  pluginId: string | null,
  cause?: unknown,
): never {
  throw new PluginRegistryError(
    code,
    message,
    pluginId,
    cause === undefined ? undefined : { cause },
  );
}
