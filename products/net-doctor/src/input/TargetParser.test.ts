import { describe, expect, it } from "vitest";
import { createNetDoctorTask } from "./createNetDoctorTask.js";
import { parseTarget } from "./TargetParser.js";

describe("parseTarget", () => {
  it("parses domain", () => {
    expect(parseTarget("example.com")).toEqual({
      raw: "example.com",
      host: "example.com",
      port: null,
      protocol: null,
      normalized: "example.com",
    });
  });

  it("parses URL", () => {
    expect(parseTarget("https://example.com/path?q=1")).toEqual({
      raw: "https://example.com/path?q=1",
      host: "example.com",
      port: null,
      protocol: "https",
      normalized: "example.com",
    });
  });

  it("parses host:port", () => {
    expect(parseTarget("example.com:443")).toEqual({
      raw: "example.com:443",
      host: "example.com",
      port: 443,
      protocol: null,
      normalized: "example.com:443",
    });
  });

  it("rejects empty target", () => {
    expect(() => parseTarget("   ")).toThrow("Target is required.");
  });

  it("creates a valid platform AgentTask", () => {
    const task = createNetDoctorTask({
      target: "https://example.com",
      symptom: "Cannot connect",
      taskId: "task_001",
      createdAt: "2026-06-04T00:00:00.000Z",
    });

    expect(task).toEqual({
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        target: {
          raw: "https://example.com",
          host: "example.com",
          port: null,
          protocol: "https",
          normalized: "example.com",
        },
        symptom: "Cannot connect",
        toolCalls: [
          {
            id: "tool_call_dns_lookup",
            toolName: "netDoctor.dnsLookup",
            input: {
              target: "example.com",
              host: "example.com",
              port: null,
              protocol: "https",
              symptom: "Cannot connect",
            },
            risk: "safe",
            metadata: {
              taskId: "task_001",
              source: "net-doctor-task-input",
            },
          },
          {
            id: "tool_call_tcp_connect",
            toolName: "netDoctor.tcpConnect",
            input: {
              target: "example.com",
              host: "example.com",
              port: null,
              protocol: "https",
              symptom: "Cannot connect",
            },
            risk: "safe",
            metadata: {
              taskId: "task_001",
              source: "net-doctor-task-input",
            },
          },
          {
            id: "tool_call_http_reachability",
            toolName: "netDoctor.httpReachability",
            input: {
              target: "example.com",
              host: "example.com",
              port: null,
              protocol: "https",
              symptom: "Cannot connect",
            },
            risk: "safe",
            metadata: {
              taskId: "task_001",
              source: "net-doctor-task-input",
            },
          },
          {
            id: "tool_call_proxy_config",
            toolName: "netDoctor.proxyConfig",
            input: {
              target: "example.com",
              host: "example.com",
              port: null,
              protocol: "https",
              symptom: "Cannot connect",
            },
            risk: "safe",
            metadata: {
              taskId: "task_001",
              source: "net-doctor-task-input",
            },
          },
        ],
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        product: "net-doctor",
        source: "vscode-extension",
      },
    });
  });
});
