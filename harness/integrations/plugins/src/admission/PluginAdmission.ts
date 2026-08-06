
import {
  assertCanonicalDataArray,
  assertExactDataProperties,
  assertPlainRecord,
  compareStrings,
  createPluginContractFingerprint,
  validatePluginDateTime,
  validatePluginText,
  validatePluginToken,
  validateSha256Fingerprint,
} from "../manifest/PluginData.js";
import {
  contributionIdentityKey,
  findPluginContribution,
  type PluginContributionKind,
} from "../manifest/PluginContribution.js";
import type { PluginManifestSnapshot } from "../manifest/PluginManifest.js";

export interface PluginManagedPolicyTrustInput {
  readonly configurationId: string;
  readonly configurationRevision: string;
  readonly configurationFingerprint: string;
}

export interface PluginManagedPolicyTrust {
  readonly configurationId: string;
  readonly configurationRevision: string;
  readonly configurationFingerprint: string;
}

interface PluginContributionAdmissionBase {
  readonly kind: PluginContributionKind;
  readonly contributionId: string;
  readonly descriptorFingerprint: string;
}

export interface PluginToolContributionAdmissionInput
  extends PluginContributionAdmissionBase {
  readonly kind: "tool";
}

export interface PluginMcpContributionAdmissionInput
  extends PluginContributionAdmissionBase {
  readonly kind: "mcpServer";
}

export interface PluginPolicyContributionAdmissionInput
  extends PluginContributionAdmissionBase {
  readonly kind: "policy";
  readonly managedTrust: PluginManagedPolicyTrustInput;
}

export type PluginContributionAdmissionInput =
  | PluginToolContributionAdmissionInput
  | PluginMcpContributionAdmissionInput
  | PluginPolicyContributionAdmissionInput;

export type PluginContributionAdmission =
  | PluginToolContributionAdmissionInput
  | PluginMcpContributionAdmissionInput
  | (Omit<PluginPolicyContributionAdmissionInput, "managedTrust"> & {
    readonly managedTrust: PluginManagedPolicyTrust;
  });

export type PluginAdmissionOutcome = "admitted" | "rejected" | "revoked";

export interface PluginAdmissionInput {
  readonly decisionId: string;
  readonly authorityId: string;
  readonly manifestFingerprint: string;
  readonly outcome: PluginAdmissionOutcome;
  readonly contributions: readonly PluginContributionAdmissionInput[];
  readonly reason: string | null;
  readonly supersedesAdmissionFingerprint: string | null;
  readonly decidedAt: string;
}

export interface PluginAdmissionSnapshot {
  readonly schemaVersion: 1;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestFingerprint: string;
  readonly decisionId: string;
  readonly authorityId: string;
  readonly outcome: PluginAdmissionOutcome;
  readonly contributions: readonly PluginContributionAdmission[];
  readonly reason: string | null;
  readonly supersedesAdmissionFingerprint: string | null;
  readonly decidedAt: string;
  readonly admissionFingerprint: string;
}

export class PluginAdmissionValidationError extends TypeError {
  constructor(
    readonly code:
      | "plugin_admission_invalid"
      | "plugin_admission_manifest_stale"
      | "plugin_admission_contribution_invalid"
      | "plugin_policy_trust_required",
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PluginAdmissionValidationError";
  }
}

export function createPluginAdmissionSnapshot(
  input: PluginAdmissionInput,
  manifest: PluginManifestSnapshot,
): PluginAdmissionSnapshot {
  try {
    assertPlainRecord(input, "admission");
    assertExactDataProperties(
      input,
      new Set([
        "decisionId",
        "authorityId",
        "manifestFingerprint",
        "outcome",
        "contributions",
        "reason",
        "supersedesAdmissionFingerprint",
        "decidedAt",
      ]),
      new Set(),
      "admission",
    );
    const manifestFingerprint = validateSha256Fingerprint(
      input.manifestFingerprint,
      "admission.manifestFingerprint",
    );
    if (manifestFingerprint !== manifest.manifestFingerprint) {
      admissionInvalid(
        "plugin_admission_manifest_stale",
        "Plugin admission does not name the current manifest.",
        "admission.manifestFingerprint",
      );
    }
    if (
      input.outcome !== "admitted" &&
      input.outcome !== "rejected" &&
      input.outcome !== "revoked"
    ) {
      admissionInvalid(
        "plugin_admission_invalid",
        "Plugin admission outcome is invalid.",
        "admission.outcome",
      );
    }
    const contributions = snapshotContributionAdmissions(
      input.contributions,
      manifest,
    );
    if (input.outcome === "admitted" && contributions.length === 0) {
      admissionInvalid(
        "plugin_admission_invalid",
        "An admitted Plugin decision must select at least one contribution.",
        "admission.contributions",
      );
    }
    if (input.outcome !== "admitted" && contributions.length !== 0) {
      admissionInvalid(
        "plugin_admission_invalid",
        "A rejected or revoked Plugin decision cannot select contributions.",
        "admission.contributions",
      );
    }
    const reason = input.reason === null
      ? null
      : validatePluginText(input.reason, "admission.reason", 4_096);
    if (input.outcome !== "admitted" && reason === null) {
      admissionInvalid(
        "plugin_admission_invalid",
        "A rejected or revoked Plugin decision requires a reason.",
        "admission.reason",
      );
    }
    const supersedesAdmissionFingerprint =
      input.supersedesAdmissionFingerprint === null
        ? null
        : validateSha256Fingerprint(
          input.supersedesAdmissionFingerprint,
          "admission.supersedesAdmissionFingerprint",
        );
    if (
      (input.outcome === "revoked") !==
        (supersedesAdmissionFingerprint !== null)
    ) {
      admissionInvalid(
        "plugin_admission_invalid",
        "Only a revoked decision must identify the admission it supersedes.",
        "admission.supersedesAdmissionFingerprint",
      );
    }
    const fields = Object.freeze({
      schemaVersion: 1 as const,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      manifestFingerprint,
      decisionId: validatePluginToken(
        input.decisionId,
        "admission.decisionId",
        1_024,
      ),
      authorityId: validatePluginToken(
        input.authorityId,
        "admission.authorityId",
        1_024,
      ),
      outcome: input.outcome,
      contributions,
      reason,
      supersedesAdmissionFingerprint,
      decidedAt: validatePluginDateTime(
        input.decidedAt,
        "admission.decidedAt",
      ),
    });
    return Object.freeze({
      ...fields,
      admissionFingerprint: createPluginContractFingerprint(
        "agent-anything.plugin-admission.v1",
        fields,
      ),
    });
  } catch (error) {
    if (error instanceof PluginAdmissionValidationError) throw error;
    const message = error instanceof Error
      ? error.message
      : "Plugin admission is invalid.";
    throw new PluginAdmissionValidationError(
      "plugin_admission_invalid",
      message,
      inferAdmissionPath(message),
    );
  }
}

export function findPluginContributionAdmission(
  admission: PluginAdmissionSnapshot,
  kind: PluginContributionKind,
  contributionId: string,
): PluginContributionAdmission | null {
  return admission.contributions.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.contributionId === contributionId,
  ) ?? null;
}

function snapshotContributionAdmissions(
  input: unknown,
  manifest: PluginManifestSnapshot,
): readonly PluginContributionAdmission[] {
  assertCanonicalDataArray(input, "admission.contributions");
  if (input.length > manifest.contributions.length) {
    admissionInvalid(
      "plugin_admission_contribution_invalid",
      "Plugin admission selects more contributions than the manifest declares.",
      "admission.contributions",
    );
  }
  const seen = new Set<string>();
  const snapshots = input.map((candidate, index) => {
    const path = `admission.contributions[${index}]`;
    assertPlainRecord(candidate, path);
    const kind = candidate.kind;
    if (kind !== "tool" && kind !== "mcpServer" && kind !== "policy") {
      admissionInvalid(
        "plugin_admission_contribution_invalid",
        "Plugin admission contribution kind is invalid.",
        `${path}.kind`,
      );
    }
    assertExactDataProperties(
      candidate,
      new Set(["kind", "contributionId", "descriptorFingerprint"]),
      kind === "policy" ? new Set(["managedTrust"]) : new Set(),
      path,
    );
    const contributionId = validatePluginToken(
      candidate.contributionId,
      `${path}.contributionId`,
    );
    const key = contributionIdentityKey({ kind, contributionId });
    if (seen.has(key)) {
      admissionInvalid(
        "plugin_admission_contribution_invalid",
        "Plugin admission contains a duplicate contribution.",
        path,
      );
    }
    seen.add(key);
    const descriptor = findPluginContribution(
      manifest.contributions,
      kind,
      contributionId,
    );
    const descriptorFingerprint = validateSha256Fingerprint(
      candidate.descriptorFingerprint,
      `${path}.descriptorFingerprint`,
    );
    if (
      descriptor === null ||
      descriptor.descriptorFingerprint !== descriptorFingerprint
    ) {
      admissionInvalid(
        "plugin_admission_contribution_invalid",
        "Plugin admission contribution does not match the manifest.",
        path,
      );
    }
    if (kind === "policy") {
      return Object.freeze({
        kind,
        contributionId,
        descriptorFingerprint,
        managedTrust: snapshotManagedTrust(candidate.managedTrust, path),
      });
    }
    return Object.freeze({
      kind,
      contributionId,
      descriptorFingerprint,
    });
  });
  snapshots.sort((left, right) =>
    compareStrings(
      contributionIdentityKey(left),
      contributionIdentityKey(right),
    )
  );
  return Object.freeze(snapshots);
}

function snapshotManagedTrust(
  input: unknown,
  contributionPath: string,
): PluginManagedPolicyTrust {
  const path = `${contributionPath}.managedTrust`;
  if (input === undefined) {
    admissionInvalid(
      "plugin_policy_trust_required",
      "A Policy contribution requires Host-managed trust configuration.",
      path,
    );
  }
  assertPlainRecord(input, path);
  assertExactDataProperties(
    input,
    new Set([
      "configurationId",
      "configurationRevision",
      "configurationFingerprint",
    ]),
    new Set(),
    path,
  );
  return Object.freeze({
    configurationId: validatePluginToken(
      input.configurationId,
      `${path}.configurationId`,
      1_024,
    ),
    configurationRevision: validatePluginToken(
      input.configurationRevision,
      `${path}.configurationRevision`,
      1_024,
    ),
    configurationFingerprint: validateSha256Fingerprint(
      input.configurationFingerprint,
      `${path}.configurationFingerprint`,
    ),
  });
}

function admissionInvalid(
  code: PluginAdmissionValidationError["code"],
  message: string,
  path: string,
): never {
  throw new PluginAdmissionValidationError(code, message, path);
}

function inferAdmissionPath(message: string): string {
  const match = message.match(/admission(?:\.[A-Za-z0-9_[\].-]+)?/);
  return match?.[0] ?? "admission";
}
