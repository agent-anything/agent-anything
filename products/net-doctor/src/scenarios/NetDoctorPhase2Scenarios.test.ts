import {
  InMemoryStorage,
  ToolRegistry,
  type PermissionService,
  type ProviderResponse,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@agent-anything/platform";
import { FakeProvider } from "@agent-anything/testing";
import { describe, expect, it } from "vitest";
import { createNetDoctorAgentRuntime } from "../agent/index.js";
import { createNetDoctorTask } from "../input/index.js";

const DNS_TOOL = "netDoctor.dnsLookup";
const TCP_TOOL = "netDoctor.tcpConnect";
const PROXY_TOOL = "netDoctor.proxyConfig";

describe("NetDoctor Phase2 agent scenarios", () => {
  it("runs provider-planned DNS then TCP then final", async () => {
    const executedTools: string[] = [];
    const provider = new FakeProvider({
      responses: [
        providerOutput({
          kind: "callTool",
          toolName: DNS_TOOL,
          reason: "Start with DNS.",
        }),
        providerOutput({
          kind: "callTool",
          toolName: TCP_TOOL,
          reason: "DNS resolved, test TCP.",
        }),
        providerOutput({
          kind: "final",
          finalOutput: {
            conclusion: "DNS resolves and TCP is reachable.",
          },
        }),
      ],
    });
    const storage = new InMemoryStorage();
    const runtime = createNetDoctorAgentRuntime({
      provider,
      storage,
      toolRegistry: createScenarioToolRegistry(executedTools),
      limits: {
        maxIterations: 4,
      },
    });

    const result = await runtime.run(createScenarioTask());

    expect(result.status).toBe("succeeded");
    expect(executedTools).toEqual([DNS_TOOL, TCP_TOOL]);
    expect(result.evidenceRefs).toEqual([
      "evidence_tool_call_dns_lookup",
      "evidence_tool_call_tcp_connect",
    ]);
    expect(result.output).toEqual({
      conclusion: "DNS resolves and TCP is reachable.",
    });
  });

  it("makes first observation visible to the second provider request", async () => {
    const provider = new FakeProvider({
      responses: [
        providerOutput({
          kind: "callTool",
          toolName: DNS_TOOL,
        }),
        providerOutput({
          kind: "final",
          finalOutput: {
            conclusion: "DNS observation was visible.",
          },
        }),
      ],
    });
    const runtime = createNetDoctorAgentRuntime({
      provider,
      storage: new InMemoryStorage(),
      toolRegistry: createScenarioToolRegistry(),
      limits: {
        maxIterations: 3,
      },
    });

    const result = await runtime.run(createScenarioTask());

    expect(result.status).toBe("succeeded");
    expect(provider.requests()).toHaveLength(2);
    expect(provider.requests()[1]?.messages[1]?.content).toContain(
      "example.com resolved to 1 address.",
    );
    expect(provider.requests()[1]?.messages[1]?.content).toContain(
      "evidence_tool_call_dns_lookup",
    );
  });

  it("returns structured stop failure when provider stops after DNS", async () => {
    const provider = new FakeProvider({
      responses: [
        providerOutput({
          kind: "callTool",
          toolName: DNS_TOOL,
        }),
        providerOutput({
          kind: "stop",
          stopReason: "DNS produced enough evidence to stop.",
        }),
      ],
    });
    const runtime = createNetDoctorAgentRuntime({
      provider,
      storage: new InMemoryStorage(),
      toolRegistry: createScenarioToolRegistry(),
      limits: {
        maxIterations: 3,
      },
    });

    const result = await runtime.run(createScenarioTask());

    expect(result).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_tool_call_dns_lookup"],
      errors: [
        {
          code: "runtime_agent_loop_stopped",
          message: "DNS produced enough evidence to stop.",
        },
      ],
    });
  });

  it("returns structured runtime failure when provider fails", async () => {
    const runtime = createNetDoctorAgentRuntime({
      provider: new FakeProvider({
        responses: [
          {
            status: "failed",
            output: null,
            usage: null,
            error: {
              code: "provider_unavailable",
              message: "Provider unavailable.",
            },
            metadata: {},
          },
        ],
      }),
      storage: new InMemoryStorage(),
      toolRegistry: createScenarioToolRegistry(),
    });

    const result = await runtime.run(createScenarioTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "provider_planner_failed",
          message: "Provider unavailable.",
        },
      ],
    });
  });

  it("returns provider_planner_failed for malformed provider output", async () => {
    const runtime = createNetDoctorAgentRuntime({
      provider: new FakeProvider({
        responses: [providerOutput("not-json")],
      }),
      storage: new InMemoryStorage(),
      toolRegistry: createScenarioToolRegistry(),
    });

    const result = await runtime.run(createScenarioTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "provider_planner_failed",
          message: "Provider output was not valid JSON.",
        },
      ],
    });
  });

  it("stops a risky planned tool when permission is denied", async () => {
    const executedTools: string[] = [];
    const runtime = createNetDoctorAgentRuntime({
      provider: new FakeProvider({
        responses: [
          providerOutput({
            kind: "callTool",
            toolName: PROXY_TOOL,
          }),
        ],
      }),
      storage: new InMemoryStorage(),
      toolRegistry: createScenarioToolRegistry(executedTools),
      permissionService: createDenyPermissionService(),
    });

    const result = await runtime.run(createScenarioTask({
      riskyToolName: PROXY_TOOL,
    }));

    expect(result).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "permission_denied",
          metadata: {
            toolName: PROXY_TOOL,
          },
        },
      ],
    });
    expect(executedTools).toEqual([]);
  });

  it("returns runtime_limit_exceeded when provider keeps planning tools", async () => {
    const runtime = createNetDoctorAgentRuntime({
      provider: new FakeProvider({
        responses: [
          providerOutput({
            kind: "callTool",
            toolName: DNS_TOOL,
          }),
          providerOutput({
            kind: "callTool",
            toolName: TCP_TOOL,
          }),
        ],
      }),
      storage: new InMemoryStorage(),
      toolRegistry: createScenarioToolRegistry(),
      limits: {
        maxIterations: 1,
      },
    });

    const result = await runtime.run(createScenarioTask());

    expect(result).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_tool_call_dns_lookup"],
      errors: [
        {
          code: "runtime_limit_exceeded",
        },
      ],
    });
  });
});

function createScenarioTask(input: {
  riskyToolName?: string;
} = {}) {
  const task = createNetDoctorTask({
    target: "https://example.com",
    symptom: "Browser cannot reach the service.",
    taskId: "task_phase2",
    createdAt: "2026-06-09T00:00:00.000Z",
  });

  if (input.riskyToolName) {
    task.input.toolCalls = task.input.toolCalls.map((toolCall) => ({
      ...toolCall,
      risk: toolCall.toolName === input.riskyToolName ? "risky" : toolCall.risk,
    }));
  }

  return task;
}

function createScenarioToolRegistry(executedTools: string[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createScenarioTool(DNS_TOOL, executedTools, {
    host: "example.com",
    addresses: [
      {
        address: "93.184.216.34",
        family: 4,
      },
    ],
  }));
  registry.register(createScenarioTool(TCP_TOOL, executedTools, {
    host: "example.com",
    port: 443,
    reachable: true,
    timeoutMs: 3000,
  }));
  registry.register(createScenarioTool(PROXY_TOOL, executedTools, {
    hasProxy: false,
    variables: [],
  }));

  return registry;
}

function createScenarioTool(
  toolName: string,
  executedTools: string[],
  output: unknown,
): ToolDefinition {
  return {
    name: toolName,
    risk: "safe",
    async execute(call) {
      executedTools.push(call.toolName);
      return createToolResult(call, output);
    },
  };
}

function createToolResult(call: ToolCall, output: unknown): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "succeeded",
    output,
    error: null,
    startedAt: "2026-06-09T00:00:00.000Z",
    finishedAt: "2026-06-09T00:00:01.000Z",
    metadata: call.metadata,
  };
}

function providerOutput(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}

function createDenyPermissionService(): PermissionService {
  return {
    async request(request) {
      return {
        requestId: request.id,
        status: "denied",
        reason: "Denied by scenario test.",
        decidedAt: "2026-06-09T00:00:00.000Z",
      };
    },
  };
}
