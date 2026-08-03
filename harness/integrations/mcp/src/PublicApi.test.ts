import type { RemoteActionCapability } from "@agent-anything/remote-integrations/action";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as mcpApi from "./index.js";
import type { McpConnectionPort } from "./index.js";

describe("MCP public API", () => {
  it("exposes only MCP-owned values", () => {
    expect(Object.keys(mcpApi).sort()).toEqual([
      "McpRegistry",
      "createMcpActionCapability",
    ]);
    expect(mcpApi).not.toHaveProperty("createRemoteActionCapability");
  });

  it("uses the public remote Action capability Contract", () => {
    expectTypeOf<McpConnectionPort>().toBeObject();
    expectTypeOf<ReturnType<typeof mcpApi.createMcpActionCapability>>()
      .toMatchTypeOf<RemoteActionCapability>();
  });
});
