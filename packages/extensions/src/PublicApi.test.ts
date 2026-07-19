import type { EnterpriseStoragePort } from "@agent-anything/extensions/enterprise-storage";
import type { McpConnectionPort } from "@agent-anything/extensions/mcp";
import type { PluginManifest } from "@agent-anything/extensions/plugins";
import type { RemoteActionCapability } from "@agent-anything/extensions/remote-actions";
import type { RemoteToolPort } from "@agent-anything/extensions/remote-tools";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as remoteActionApi from "./action-registrations/index.js";
import * as enterpriseStorageApi from "./enterprise-storage/index.js";
import * as extensionsApi from "./index.js";
import * as mcpApi from "./mcp/index.js";
import * as pluginApi from "./plugins/index.js";
import * as remoteToolApi from "./remote-tools/index.js";

describe("Extensions public API", () => {
  it("exposes the reviewed aggregate and focused extension values", () => {
    expect(Object.keys(extensionsApi).sort()).toEqual([
      "McpRegistry",
      "PluginRegistry",
      "PluginRegistryError",
      "createMcpActionCapability",
      "createRemoteActionCapability",
      "createRemoteToolActionCapability",
    ]);
    expect(Object.keys(remoteToolApi).sort()).toEqual(["createRemoteToolActionCapability"]);
    expect(Object.keys(remoteActionApi).sort()).toEqual(["createRemoteActionCapability"]);
    expect(Object.keys(mcpApi).sort()).toEqual(["McpRegistry", "createMcpActionCapability"]);
    expect(Object.keys(pluginApi).sort()).toEqual(["PluginRegistry", "PluginRegistryError"]);
    expect(Object.keys(enterpriseStorageApi)).toEqual([]);
  });

  it("resolves focused types without exposing an alternate execution path", () => {
    expectTypeOf<RemoteToolPort>().toBeObject();
    expectTypeOf<RemoteActionCapability>().toBeObject();
    expectTypeOf<McpConnectionPort>().toBeObject();
    expectTypeOf<PluginManifest>().toBeObject();
    expectTypeOf<EnterpriseStoragePort>().toBeObject();
    expect(extensionsApi).not.toHaveProperty("Runner");
    expect(extensionsApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(extensionsApi).not.toHaveProperty("createSandboxExecutionGateway");
    expect(extensionsApi).not.toHaveProperty("createHostRuntime");
  });
});
