import {
  assertCanonicalDataArray,
  assertExactDataProperties,
  assertPlainRecord,
  compareStrings,
  createPluginContractFingerprint,
  type PluginJsonObject,
  snapshotPluginJsonObject,
  validatePluginText,
  validatePluginToken,
} from "./PluginData.js";

export type PluginContributionKind = "tool" | "mcpServer" | "policy";

export type PluginContributionDestinationOwner =
  | "tools"
  | "mcp"
  | "governance";

export interface PluginContributionInput {
  readonly kind: PluginContributionKind;
  readonly id: string;
  readonly displayName: string;
  readonly declaration: PluginJsonObject;
  readonly metadata: PluginJsonObject;
}

export interface PluginContributionDescriptor {
  readonly kind: PluginContributionKind;
  readonly id: string;
  readonly displayName: string;
  readonly destinationOwner: PluginContributionDestinationOwner;
  readonly declaration: PluginJsonObject;
  readonly metadata: PluginJsonObject;
  readonly descriptorFingerprint: string;
}

export interface PluginContributionIdentity {
  readonly pluginId: string;
  readonly kind: PluginContributionKind;
  readonly contributionId: string;
}

export function snapshotPluginContributions(
  input: unknown,
  path: string,
): readonly PluginContributionDescriptor[] {
  assertCanonicalDataArray(input, path);
  if (input.length > 256) {
    throw new TypeError(`${path} exceeds the contribution limit.`);
  }
  const seen = new Set<string>();
  const contributions = input.map((candidate, index) => {
    const contributionPath = `${path}[${index}]`;
    assertPlainRecord(candidate, contributionPath);
    assertExactDataProperties(
      candidate,
      new Set(["kind", "id", "displayName", "declaration", "metadata"]),
      new Set(),
      contributionPath,
    );
    const kind = validateContributionKind(
      candidate.kind,
      `${contributionPath}.kind`,
    );
    const id = validatePluginToken(
      candidate.id,
      `${contributionPath}.id`,
      256,
    );
    const identity = `${kind}\u0000${id}`;
    if (seen.has(identity)) {
      throw new TypeError(`${contributionPath} duplicates a contribution.`);
    }
    seen.add(identity);
    const fields = Object.freeze({
      kind,
      id,
      displayName: validatePluginText(
        candidate.displayName,
        `${contributionPath}.displayName`,
        512,
      ),
      destinationOwner: destinationOwner(kind),
      declaration: snapshotPluginJsonObject(
        candidate.declaration,
        `${contributionPath}.declaration`,
      ),
      metadata: snapshotPluginJsonObject(
        candidate.metadata,
        `${contributionPath}.metadata`,
      ),
    });
    return Object.freeze({
      ...fields,
      descriptorFingerprint: createPluginContractFingerprint(
        "agent-anything.plugin-contribution.v1",
        fields,
      ),
    });
  });
  contributions.sort((left, right) =>
    compareStrings(
      `${left.kind}\u0000${left.id}`,
      `${right.kind}\u0000${right.id}`,
    )
  );
  return Object.freeze(contributions);
}

export function findPluginContribution(
  contributions: readonly PluginContributionDescriptor[],
  kind: PluginContributionKind,
  contributionId: string,
): PluginContributionDescriptor | null {
  return contributions.find(
    (candidate) =>
      candidate.kind === kind && candidate.id === contributionId,
  ) ?? null;
}

export function contributionIdentityKey(input: {
  readonly kind: PluginContributionKind;
  readonly contributionId: string;
}): string {
  return `${input.kind}\u0000${input.contributionId}`;
}

function validateContributionKind(
  input: unknown,
  path: string,
): PluginContributionKind {
  if (input !== "tool" && input !== "mcpServer" && input !== "policy") {
    throw new TypeError(`${path} is not a supported contribution kind.`);
  }
  return input;
}

function destinationOwner(
  kind: PluginContributionKind,
): PluginContributionDestinationOwner {
  switch (kind) {
    case "tool":
      return "tools";
    case "mcpServer":
      return "mcp";
    case "policy":
      return "governance";
  }
}
