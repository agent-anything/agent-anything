import { describe, expect, it } from "vitest";
import { FakePluginRegistry } from "../testing/index.js";
import { PluginRegistry } from "./PluginRegistry.js";
import type { PluginManifest } from "./PluginManifest.js";

describe("PluginRegistry", () => {
  it("validates a valid plugin manifest", () => {
    const registry = new PluginRegistry();

    const result = registry.validate(createManifest());

    expect(result).toMatchObject({
      status: "valid",
      issues: [],
      metadata: {
        pluginId: "plugin_001",
      },
    });
  });

  it("rejects empty plugin id, name, or version", () => {
    const registry = new PluginRegistry();

    const result = registry.validate(createManifest({
      id: "",
    }));

    expect(result).toMatchObject({
      status: "invalid",
      issues: [
        {
          code: "plugin_invalid_manifest",
        },
      ],
    });
  });

  it("rejects invalid contribution kinds", () => {
    const registry = new PluginRegistry();

    const result = registry.validate({
      ...createManifest(),
      contributions: [
        {
          kind: "unknown",
          id: "contribution_001",
          metadata: {},
        } as never,
      ],
    });

    expect(result).toMatchObject({
      status: "invalid",
      issues: [
        {
          code: "plugin_invalid_contribution",
        },
      ],
    });
  });

  it("rejects empty contribution ids", () => {
    const registry = new PluginRegistry();

    const result = registry.validate({
      ...createManifest(),
      contributions: [
        {
          kind: "tool",
          id: "",
          metadata: {},
        },
      ],
    });

    expect(result).toMatchObject({
      status: "invalid",
      issues: [
        {
          code: "plugin_invalid_contribution",
        },
      ],
    });
  });

  it("registers valid manifests and lists contributions", () => {
    const registry = new PluginRegistry();

    registry.register(createManifest());

    expect(registry.listManifests()).toHaveLength(1);
    expect(registry.listContributions()).toMatchObject([
      {
        kind: "tool",
        id: "tool.lookup",
      },
      {
        kind: "mcpServer",
        id: "mcp.network",
      },
    ]);
    expect(registry.listContributionsByKind("tool")).toMatchObject([
      {
        kind: "tool",
        id: "tool.lookup",
      },
    ]);
  });

  it("rejects duplicate plugin ids", () => {
    const registry = new PluginRegistry();

    registry.register(createManifest());

    expect(() => registry.register(createManifest())).toThrow(
      "Plugin manifest 'plugin_001' is already registered.",
    );
  });

  it("rejects duplicate contribution ids within the same kind", () => {
    const registry = new PluginRegistry();

    registry.register(createManifest());

    expect(() => registry.register(createManifest({
      id: "plugin_002",
      contributions: [
        {
          kind: "tool",
          id: "tool.lookup",
          metadata: {},
        },
      ],
    }))).toThrow("Plugin contribution 'tool:tool.lookup' is already registered.");
  });

  it("allows the same contribution id across different kinds", () => {
    const registry = new PluginRegistry();

    registry.register(createManifest({
      contributions: [
        {
          kind: "tool",
          id: "shared",
          metadata: {},
        },
        {
          kind: "policy",
          id: "shared",
          metadata: {},
        },
      ],
    }));

    expect(registry.listContributions()).toHaveLength(2);
  });

  it("fake plugin registry records manifests", async () => {
    const registry = new FakePluginRegistry();

    await registry.register(createManifest());

    expect(registry.listManifests()).toHaveLength(1);
    expect(registry.listContributionsByKind("mcpServer")).toMatchObject([
      {
        id: "mcp.network",
      },
    ]);
  });
});

function createManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id: "plugin_001",
    name: "Plugin 001",
    version: "0.1.0",
    contributions: [
      {
        kind: "tool",
        id: "tool.lookup",
        metadata: {},
      },
      {
        kind: "mcpServer",
        id: "mcp.network",
        metadata: {},
      },
    ],
    metadata: {},
    ...overrides,
  };
}
