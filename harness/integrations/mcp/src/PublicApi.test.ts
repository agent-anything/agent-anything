import type { RemoteOperationContribution } from "@agent-anything/remote-integrations/operation";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as adaptersApi from "./adapters/index.js";
import * as lifecycleApi from "./lifecycle/index.js";
import type {
  McpActivationResolver,
} from "./lifecycle/index.js";
import * as primitivesApi from "./primitives/index.js";
import type {
  McpSourceResolver,
  McpToolOperationPort,
} from "./primitives/index.js";
import * as protocolApi from "./protocol/index.js";
import * as registrationApi from "./registration/index.js";
import * as transportApi from "./transport/index.js";
import type { McpTransportConnector } from "./transport/index.js";

describe("MCP public API", () => {
  it("publishes six focused semantic surfaces", () => {
    expect(Object.keys(registrationApi).sort()).toEqual([
      "MCP_PROTOCOL_REVISION",
      "McpRegistrationError",
      "createMcpServerRegistration",
    ].sort());
    expect(Object.keys(lifecycleApi).sort()).toEqual([
      "McpActivationError",
      "McpRegistry",
    ].sort());
    expect(Object.keys(transportApi)).toEqual([]);
    expect(Object.keys(protocolApi).sort()).toEqual([
      "McpOperationError",
      "McpProtocolError",
    ].sort());
    expect(Object.keys(primitivesApi)).toEqual(["McpPrimitiveError"]);
    expect(Object.keys(adaptersApi)).toEqual(["createMcpOperationContribution"]);
  });

  it("keeps transport, lifecycle, primitives, and adapters distinct", () => {
    expectTypeOf<McpTransportConnector>().toBeObject();
    expectTypeOf<McpActivationResolver>().toBeObject();
    expectTypeOf<McpSourceResolver>().toBeObject();
    expectTypeOf<McpToolOperationPort>().toBeObject();
    expectTypeOf<ReturnType<typeof adaptersApi.createMcpOperationContribution>>()
      .toMatchTypeOf<RemoteOperationContribution>();
  });

  it("does not expose private coordinators or protocol helpers", () => {
    expect(lifecycleApi).not.toHaveProperty("McpTransportOperations");
    expect(primitivesApi).not.toHaveProperty("McpPrimitiveCoordinator");
    expect(primitivesApi).not.toHaveProperty("McpPrimitiveInventoryLoader");
    expect(protocolApi).not.toHaveProperty("parseMcpDiscoverResponse");
    expect(protocolApi).not.toHaveProperty("compileMcpSchema");
  });
});
