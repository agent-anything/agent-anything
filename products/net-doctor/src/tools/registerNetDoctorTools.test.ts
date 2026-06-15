import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolCall } from "@agent-anything/tools";
import { registerNetDoctorTools } from "./registerNetDoctorTools.js";

describe("registerNetDoctorTools", () => {
  it("registers all Phase1 NetDoctor tools", () => {
    const registry = new ToolRegistry();

    registerNetDoctorTools(registry);

    expect(registry.list().map((tool) => tool.name).sort()).toEqual([
      "netDoctor.dnsLookup",
      "netDoctor.httpReachability",
      "netDoctor.proxyConfig",
      "netDoctor.tcpConnect",
    ]);
  });

  it("each tool returns a structured ToolResult", async () => {
    const registry = new ToolRegistry();
    registerNetDoctorTools(registry);

    for (const tool of registry.list()) {
      const result = await registry.execute(createToolCall(tool.name));

      expect(result.toolCallId).toBe(`tool_call_${tool.name}`);
      expect(result.toolName).toBe(tool.name);
      expect(result.startedAt).toEqual(expect.any(String));
      expect(result.finishedAt).toEqual(expect.any(String));
      expect(["succeeded", "failed"]).toContain(result.status);
    }
  });

  it("tool failure returns a structured failed ToolResult", async () => {
    const registry = new ToolRegistry();
    registerNetDoctorTools(registry);

    const result = await registry.execute({
      id: "tool_call_bad_input",
      toolName: "netDoctor.dnsLookup",
      input: {},
      risk: "safe",
      metadata: {
        taskId: "task_001",
      },
    });

    expect(result).toMatchObject({
      toolCallId: "tool_call_bad_input",
      toolName: "netDoctor.dnsLookup",
      status: "failed",
      output: null,
      error: {
        code: "dns_lookup_failed",
      },
    });
  });

  it("all Phase1 tools are read-only safe tools", () => {
    const registry = new ToolRegistry();
    registerNetDoctorTools(registry);

    expect(registry.list().every((tool) => tool.risk === "safe")).toBe(true);
  });
});

function createToolCall(toolName: string): ToolCall {
  return {
    id: `tool_call_${toolName}`,
    toolName,
    input: {
      target: "localhost:1",
      host: "localhost",
      port: 1,
      protocol: "http",
      symptom: "test",
    },
    risk: "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}
