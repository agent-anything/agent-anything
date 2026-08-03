import type {
  PluginContribution,
  PluginContributionKind,
} from "./PluginContribution.js";
import type { PluginManifest } from "./PluginManifest.js";
import {
  PluginRegistryError,
  type PluginValidationIssue,
  type PluginValidationResult,
} from "./PluginValidationResult.js";

const contributionKinds: PluginContributionKind[] = ["tool", "mcpServer", "policy"];

export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly contributionIdsByKind = new Map<PluginContributionKind, Set<string>>();

  validate(manifest: PluginManifest): PluginValidationResult {
    const issues = validateManifestShape(manifest);
    const seenContributionIds = new Map<PluginContributionKind, Set<string>>();

    for (const contribution of manifest.contributions) {
      const kind = contribution.kind;
      if (!isPluginContributionKind(kind)) {
        continue;
      }

      const ids = seenContributionIds.get(kind) ?? new Set<string>();
      if (ids.has(contribution.id)) {
        issues.push(createIssue(
          "plugin_duplicate_contribution",
          `Plugin contribution '${kind}:${contribution.id}' is duplicated in manifest '${manifest.id}'.`,
          {
            pluginId: manifest.id,
            contributionKind: kind,
            contributionId: contribution.id,
          },
        ));
      }
      ids.add(contribution.id);
      seenContributionIds.set(kind, ids);
    }

    return {
      status: issues.length === 0 ? "valid" : "invalid",
      issues,
      metadata: {
        pluginId: manifest.id,
      },
    };
  }

  register(manifest: PluginManifest): void {
    const validation = this.validate(manifest);
    if (validation.status === "invalid") {
      throw createRegistryError(
        "plugin_invalid_manifest",
        `Plugin manifest '${manifest.id}' is invalid.`,
        validation.issues,
      );
    }

    if (this.manifests.has(manifest.id)) {
      throw createRegistryError(
        "plugin_duplicate_manifest",
        `Plugin manifest '${manifest.id}' is already registered.`,
        [
          createIssue(
            "plugin_duplicate_manifest",
            `Plugin manifest '${manifest.id}' is already registered.`,
            {
              pluginId: manifest.id,
            },
          ),
        ],
      );
    }

    for (const contribution of manifest.contributions) {
      const ids = this.contributionIdsByKind.get(contribution.kind) ?? new Set<string>();
      if (ids.has(contribution.id)) {
        throw createRegistryError(
          "plugin_duplicate_contribution",
          `Plugin contribution '${contribution.kind}:${contribution.id}' is already registered.`,
          [
            createIssue(
              "plugin_duplicate_contribution",
              `Plugin contribution '${contribution.kind}:${contribution.id}' is already registered.`,
              {
                pluginId: manifest.id,
                contributionKind: contribution.kind,
                contributionId: contribution.id,
              },
            ),
          ],
        );
      }
    }

    this.manifests.set(manifest.id, manifest);
    for (const contribution of manifest.contributions) {
      const ids = this.contributionIdsByKind.get(contribution.kind) ?? new Set<string>();
      ids.add(contribution.id);
      this.contributionIdsByKind.set(contribution.kind, ids);
    }
  }

  listManifests(): PluginManifest[] {
    return [...this.manifests.values()];
  }

  listContributions(): PluginContribution[] {
    return this.listManifests().flatMap((manifest) => manifest.contributions);
  }

  listContributionsByKind(kind: PluginContributionKind): PluginContribution[] {
    return this.listContributions().filter((contribution) => contribution.kind === kind);
  }
}

function validateManifestShape(manifest: PluginManifest): PluginValidationIssue[] {
  const issues: PluginValidationIssue[] = [];

  if (manifest.id.trim() === "" || manifest.name.trim() === "" || manifest.version.trim() === "") {
    issues.push(createIssue(
      "plugin_invalid_manifest",
      "Plugin manifest id, name, and version must not be empty.",
      {
        pluginId: manifest.id,
      },
    ));
  }

  for (const contribution of manifest.contributions) {
    if (!isPluginContributionKind(contribution.kind)) {
      issues.push(createIssue(
        "plugin_invalid_contribution",
        `Plugin contribution kind '${String(contribution.kind)}' is not supported.`,
        {
          pluginId: manifest.id,
          contributionKind: String(contribution.kind),
          contributionId: contribution.id,
        },
      ));
      continue;
    }

    if (contribution.id.trim() === "") {
      issues.push(createIssue(
        "plugin_invalid_contribution",
        "Plugin contribution id must not be empty.",
        {
          pluginId: manifest.id,
          contributionKind: contribution.kind,
        },
      ));
    }
  }

  return issues;
}

function isPluginContributionKind(value: unknown): value is PluginContributionKind {
  return contributionKinds.includes(value as PluginContributionKind);
}

function createIssue(
  code: string,
  message: string,
  metadata: Record<string, unknown>,
): PluginValidationIssue {
  return {
    code,
    message,
    metadata,
  };
}

function createRegistryError(
  code: string,
  message: string,
  issues: PluginValidationIssue[],
): PluginRegistryError {
  return new PluginRegistryError({
    code,
    message,
    issues,
  });
}
