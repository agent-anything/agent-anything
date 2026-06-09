import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolCall } from "@agent-anything/platform";
import { createNetDoctorToolAdapters } from "./createNetDoctorToolAdapters.js";
import { registerNetDoctorToolAdapters } from "./registerNetDoctorToolAdapters.js";

describe("NetDoctor tool adapters", () => {
  it("creates adapters for all NetDoctor tools", () => {
    const adapters = createNetDoctorToolAdapters();

    expect(adapters.map((adapter) => adapter.name).sort()).toEqual([
      "netDoctor.dnsLookup",
      "netDoctor.httpReachability",
      "netDoctor.proxyConfig",
      "netDoctor.tcpConnect",
    ]);
  });

  it("registers adapted tools into ToolRegistry", () => {
    const toolRegistry = new ToolRegistry();
    const adapterRegistry = registerNetDoctorToolAdapters(toolRegistry);

    expect(adapterRegistry.list().map((adapter) => adapter.name).sort()).toEqual([
      "netDoctor.dnsLookup",
      "netDoctor.httpReachability",
      "netDoctor.proxyConfig",
      "netDoctor.tcpConnect",
    ]);
    expect(toolRegistry.list().map((tool) => tool.name).sort()).toEqual([
      "netDoctor.dnsLookup",
      "netDoctor.httpReachability",
      "netDoctor.proxyConfig",
      "netDoctor.tcpConnect",
    ]);
    expect(toolRegistry.get("netDoctor.dnsLookup")?.metadata).toMatchObject({
      adapter: "net-doctor-tool-definition",
      product: "net-doctor",
    });
  });

  it("executes adapted tools through the normal registry path", async () => {
    const toolRegistry = new ToolRegistry();
    registerNetDoctorToolAdapters(toolRegistry);

    const result = await toolRegistry.execute(createToolCall("netDoctor.proxyConfig"));

    expect(result).toMatchObject({
      toolCallId: "tool_call_netDoctor.proxyConfig",
      toolName: "netDoctor.proxyConfig",
      status: "succeeded",
      output: {
        hasProxy: expect.any(Boolean),
      },
    });
  });
});

function createToolCall(toolName: string): ToolCall {
  return {
    id: `tool_call_${toolName}`,
    toolName,
    input: {
      target: "example.com",
      host: "example.com",
      port: 443,
      protocol: "https",
      symptom: "test",
    },
    risk: "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}
