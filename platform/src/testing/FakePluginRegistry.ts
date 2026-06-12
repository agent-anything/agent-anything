import type {
  PluginContribution,
  PluginContributionKind,
  PluginManifest,
} from "../plugins/index.js";

export type FakePluginRegistryHandler = (
  manifest: PluginManifest,
) => void | Promise<void>;

export class FakePluginRegistry {
  readonly manifests: PluginManifest[] = [];

  constructor(
    private readonly handler?: FakePluginRegistryHandler,
  ) {}

  async register(manifest: PluginManifest): Promise<void> {
    await this.handler?.(manifest);
    this.manifests.push(manifest);
  }

  listManifests(): PluginManifest[] {
    return [...this.manifests];
  }

  listContributions(): PluginContribution[] {
    return this.manifests.flatMap((manifest) => manifest.contributions);
  }

  listContributionsByKind(kind: PluginContributionKind): PluginContribution[] {
    return this.listContributions().filter((contribution) => contribution.kind === kind);
  }
}
