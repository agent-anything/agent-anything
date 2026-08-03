import type { RemoteActionCapability } from "@agent-anything/remote-integrations/action";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as mcpApi from "./index.js";
import type {
  McpActivationResolver,
  McpToolOperationPort,
  McpTransportConnector,
} from "./index.js";

describe("MCP public API", () => {
  it("exposes only MCP-owned values", () => {
    expect(Object.keys(mcpApi).sort()).toEqual([
      "MCP_PROTOCOL_REVISION",
      "McpActivationError",
      "McpRegistrationError",
      "McpRegistry",
      "createMcpServerRegistration",
      "createMcpActionCapability",
    ].sort());
    expect(mcpApi).not.toHaveProperty("createRemoteActionCapability");
  });

  it("uses the public remote Action capability Contract", () => {
    expectTypeOf<McpTransportConnector>().toBeObject();
    expectTypeOf<McpActivationResolver>().toBeObject();
    expectTypeOf<McpToolOperationPort>().toBeObject();
    expectTypeOf<ReturnType<typeof mcpApi.createMcpActionCapability>>()
      .toMatchTypeOf<RemoteActionCapability>();
  });
});
