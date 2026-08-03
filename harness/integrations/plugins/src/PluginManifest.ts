import { satisfies, valid, validRange } from "semver";
import {
  assertExactDataProperties,
  assertPlainRecord,
  createPluginContractFingerprint,
  type PluginJsonObject,
  snapshotPluginJsonObject,
  snapshotPluginTokenSet,
  validatePluginText,
  validatePluginToken,
  validateSha256Fingerprint,
} from "./PluginData.js";
import {
  snapshotPluginContributions,
  type PluginContributionDescriptor,
  type PluginContributionInput,
} from "./PluginContribution.js";

export type PluginPackageSourceKind = "local" | "registry" | "managed";

export interface PluginPackageProvenanceInput {
  readonly sourceKind: PluginPackageSourceKind;
  readonly sourceId: string;
  readonly packageDigest: string;
  readonly publisherId?: string | null;
}

export interface PluginPackageProvenance {
  readonly sourceKind: PluginPackageSourceKind;
  readonly sourceId: string;
  readonly packageDigest: string;
  readonly publisherId: string | null;
}

export interface PluginCompatibilityInput {
  readonly harnessPluginApiRange: string;
  readonly requiredHostCapabilityIds: readonly string[];
}

export interface PluginCompatibility {
  readonly harnessPluginApiRange: string;
  readonly requiredHostCapabilityIds: readonly string[];
}

export interface PluginManifestInput {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly provenance: PluginPackageProvenanceInput;
  readonly compatibility: PluginCompatibilityInput;
  readonly contributions: readonly PluginContributionInput[];
  readonly metadata: PluginJsonObject;
}

export interface PluginManifestSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly provenance: PluginPackageProvenance;
  readonly compatibility: PluginCompatibility;
  readonly contributions: readonly PluginContributionDescriptor[];
  readonly metadata: PluginJsonObject;
  readonly manifestFingerprint: string;
}

export interface PluginManifestEnvironmentInput {
  readonly harnessPluginApiVersion: string;
  readonly hostCapabilityIds: readonly string[];
}

export interface PluginManifestEnvironment {
  readonly harnessPluginApiVersion: string;
  readonly hostCapabilityIds: readonly string[];
}

export type PluginManifestValidationCode =
  | "plugin_manifest_invalid"
  | "plugin_manifest_version_invalid"
  | "plugin_manifest_compatibility_invalid"
  | "plugin_manifest_incompatible"
  | "plugin_host_capability_missing";

export interface PluginManifestValidationIssue {
  readonly code: PluginManifestValidationCode;
  readonly message: string;
  readonly path: string;
}

export type PluginManifestValidationResult =
  | {
    readonly status: "valid";
    readonly manifest: PluginManifestSnapshot;
    readonly issues: readonly [];
  }
  | {
    readonly status: "invalid";
    readonly manifest: null;
    readonly issues: readonly PluginManifestValidationIssue[];
  };

export class PluginManifestValidationError extends TypeError {
  constructor(
    readonly code: PluginManifestValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PluginManifestValidationError";
  }
}

export function snapshotPluginManifestEnvironment(
  input: PluginManifestEnvironmentInput,
): PluginManifestEnvironment {
  assertPlainRecord(input, "environment");
  assertExactDataProperties(
    input,
    new Set(["harnessPluginApiVersion", "hostCapabilityIds"]),
    new Set(),
    "environment",
  );
  const version = canonicalSemVer(
    input.harnessPluginApiVersion,
    "environment.harnessPluginApiVersion",
  );
  return Object.freeze({
    harnessPluginApiVersion: version,
    hostCapabilityIds: snapshotPluginTokenSet(
      input.hostCapabilityIds,
      "environment.hostCapabilityIds",
    ),
  });
}

export function validatePluginManifest(
  input: unknown,
  environmentInput: PluginManifestEnvironmentInput,
): PluginManifestValidationResult {
  try {
    return Object.freeze({
      status: "valid" as const,
      manifest: createPluginManifestSnapshot(input, environmentInput),
      issues: Object.freeze([]) as readonly [],
    });
  } catch (error) {
    const normalized = normalizeManifestError(error);
    return Object.freeze({
      status: "invalid" as const,
      manifest: null,
      issues: Object.freeze([
        Object.freeze({
          code: normalized.code,
          message: normalized.message,
          path: normalized.path,
        }),
      ]),
    });
  }
}

export function createPluginManifestSnapshot(
  input: unknown,
  environmentInput: PluginManifestEnvironmentInput,
): PluginManifestSnapshot {
  try {
    const environment = snapshotPluginManifestEnvironment(environmentInput);
    assertPlainRecord(input, "manifest");
    assertExactDataProperties(
      input,
      new Set([
        "id",
        "displayName",
        "version",
        "provenance",
        "compatibility",
        "contributions",
        "metadata",
      ]),
      new Set(),
      "manifest",
    );
    const provenance = snapshotProvenance(input.provenance);
    const compatibility = snapshotCompatibility(
      input.compatibility,
      environment,
    );
    const contributions = snapshotPluginContributions(
      input.contributions,
      "manifest.contributions",
    );
    if (contributions.length === 0) {
      invalid(
        "plugin_manifest_invalid",
        "Plugin manifest must declare at least one contribution.",
        "manifest.contributions",
      );
    }
    const fields = Object.freeze({
      schemaVersion: 1 as const,
      id: validatePluginToken(input.id, "manifest.id"),
      displayName: validatePluginText(
        input.displayName,
        "manifest.displayName",
        512,
      ),
      version: canonicalSemVer(input.version, "manifest.version"),
      provenance,
      compatibility,
      contributions,
      metadata: snapshotPluginJsonObject(input.metadata, "manifest.metadata"),
    });
    return Object.freeze({
      ...fields,
      manifestFingerprint: createPluginContractFingerprint(
        "agent-anything.plugin-manifest.v1",
        fields,
      ),
    });
  } catch (error) {
    throw normalizeManifestError(error);
  }
}

function snapshotProvenance(input: unknown): PluginPackageProvenance {
  assertPlainRecord(input, "manifest.provenance");
  assertExactDataProperties(
    input,
    new Set(["sourceKind", "sourceId", "packageDigest"]),
    new Set(["publisherId"]),
    "manifest.provenance",
  );
  if (
    input.sourceKind !== "local" &&
    input.sourceKind !== "registry" &&
    input.sourceKind !== "managed"
  ) {
    invalid(
      "plugin_manifest_invalid",
      "Plugin package source kind is invalid.",
      "manifest.provenance.sourceKind",
    );
  }
  return Object.freeze({
    sourceKind: input.sourceKind,
    sourceId: validatePluginToken(
      input.sourceId,
      "manifest.provenance.sourceId",
      1_024,
    ),
    packageDigest: validateSha256Fingerprint(
      input.packageDigest,
      "manifest.provenance.packageDigest",
    ),
    publisherId: input.publisherId === undefined || input.publisherId === null
      ? null
      : validatePluginToken(
        input.publisherId,
        "manifest.provenance.publisherId",
      ),
  });
}

function snapshotCompatibility(
  input: unknown,
  environment: PluginManifestEnvironment,
): PluginCompatibility {
  assertPlainRecord(input, "manifest.compatibility");
  assertExactDataProperties(
    input,
    new Set(["harnessPluginApiRange", "requiredHostCapabilityIds"]),
    new Set(),
    "manifest.compatibility",
  );
  if (
    typeof input.harnessPluginApiRange !== "string" ||
    input.harnessPluginApiRange.length === 0 ||
    input.harnessPluginApiRange.length > 1_024 ||
    input.harnessPluginApiRange !== input.harnessPluginApiRange.trim()
  ) {
    invalid(
      "plugin_manifest_compatibility_invalid",
      "Harness Plugin API range must be bounded non-empty text.",
      "manifest.compatibility.harnessPluginApiRange",
    );
  }
  const range = validRange(input.harnessPluginApiRange, {
    includePrerelease: true,
  });
  if (range === null || range === "*") {
    invalid(
      "plugin_manifest_compatibility_invalid",
      "Harness Plugin API range must be a non-wildcard Semantic Version range.",
      "manifest.compatibility.harnessPluginApiRange",
    );
  }
  if (
    !satisfies(environment.harnessPluginApiVersion, range, {
      includePrerelease: true,
    })
  ) {
    invalid(
      "plugin_manifest_incompatible",
      `Plugin does not support Harness Plugin API '${environment.harnessPluginApiVersion}'.`,
      "manifest.compatibility.harnessPluginApiRange",
    );
  }
  const requiredHostCapabilityIds = snapshotPluginTokenSet(
    input.requiredHostCapabilityIds,
    "manifest.compatibility.requiredHostCapabilityIds",
  );
  const available = new Set(environment.hostCapabilityIds);
  const missing = requiredHostCapabilityIds.find(
    (capabilityId) => !available.has(capabilityId),
  );
  if (missing !== undefined) {
    invalid(
      "plugin_host_capability_missing",
      `Required Host capability '${missing}' is unavailable.`,
      "manifest.compatibility.requiredHostCapabilityIds",
    );
  }
  return Object.freeze({
    harnessPluginApiRange: range,
    requiredHostCapabilityIds,
  });
}

function canonicalSemVer(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 256 ||
    input !== input.trim()
  ) {
    invalid(
      "plugin_manifest_version_invalid",
      `${path} must be a canonical Semantic Version.`,
      path,
    );
  }
  const canonical = valid(input);
  if (canonical === null || canonical !== input) {
    invalid(
      "plugin_manifest_version_invalid",
      `${path} must be a canonical Semantic Version.`,
      path,
    );
  }
  return canonical;
}

function invalid(
  code: PluginManifestValidationCode,
  message: string,
  path: string,
): never {
  throw new PluginManifestValidationError(code, message, path);
}

function normalizeManifestError(error: unknown): PluginManifestValidationError {
  if (error instanceof PluginManifestValidationError) return error;
  const message = error instanceof Error
    ? error.message
    : "Plugin manifest is invalid.";
  return new PluginManifestValidationError(
    "plugin_manifest_invalid",
    message,
    inferManifestPath(message),
  );
}

function inferManifestPath(message: string): string {
  const match = message.match(
    /(?:manifest|environment)(?:\.[A-Za-z0-9_[\].-]+)?/,
  );
  return match?.[0] ?? "manifest";
}
