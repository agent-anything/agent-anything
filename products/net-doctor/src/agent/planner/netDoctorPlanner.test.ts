import {
  FakeProvider,
  type ContextSnapshot,
  type PlannerInput,
  type ProviderResponse,
  type ToolCall,
} from "@agent-anything/platform";
import { describe, expect, it } from "vitest";
import type { NetDoctorInput } from "../../input/index.js";
import { buildNetDoctorProviderRequest } from "./buildNetDoctorProviderRequest.js";
import { createNetDoctorPlanner } from "./createNetDoctorPlanner.js";
import { parseNetDoctorProviderResponse } from "./parseNetDoctorProviderResponse.js";

describe("NetDoctor planner request", () => {
  it("includes task, tools, observations, and evidence refs without raw evidence content", () => {
    const request = buildNetDoctorProviderRequest(createPlannerInput());

    expect(request.capability).toBe("net-doctor.tool-planning");
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]?.content).toContain("Target: https://example.com");
    expect(request.messages[1]?.content).toContain("Symptom: Browser cannot reach the service.");
    expect(request.messages[1]?.content).toContain("- netDoctor.dnsLookup");
    expect(request.messages[1]?.content).toContain("DNS lookup returned one address.");
    expect(request.messages[1]?.content).toContain("evidence_dns");
    expect(request.messages[1]?.content).not.toContain("93.184.216.34");
    expect(request.messages[1]?.content).not.toContain("http://user:password@proxy.local:8080");
  });
});

describe("NetDoctor provider response parser", () => {
  it("maps provider callTool output to an existing NetDoctor tool call", () => {
    const planStep = parseNetDoctorProviderResponse(
      createProviderResponse({
        kind: "callTool",
        toolName: "netDoctor.tcpConnect",
        reason: "DNS evidence exists, test TCP next.",
      }),
      createPlannerInput(),
    );

    expect(planStep).toMatchObject({
      id: "plan_step_task_001_netDoctor_tcpConnect",
      kind: "callTool",
      reason: "DNS evidence exists, test TCP next.",
      toolCall: {
        id: "tool_call_tcp_connect",
        toolName: "netDoctor.tcpConnect",
      },
    });
  });

  it("maps provider final output to a final plan step", () => {
    const planStep = parseNetDoctorProviderResponse(
      createProviderResponse({
        kind: "final",
        finalOutput: {
          conclusion: "DNS and TCP checks are enough.",
        },
      }),
      createPlannerInput(),
    );

    expect(planStep).toEqual({
      id: "plan_step_task_001_final",
      kind: "final",
      finalOutput: {
        conclusion: "DNS and TCP checks are enough.",
      },
      reason: "Provider returned final diagnosis.",
      metadata: {
        product: "net-doctor",
        providerMetadata: {},
      },
    });
  });

  it("maps provider stop output to a stop plan step", () => {
    const planStep = parseNetDoctorProviderResponse(
      createProviderResponse({
        kind: "stop",
        stopReason: "User input is not a network target.",
      }),
      createPlannerInput(),
    );

    expect(planStep).toMatchObject({
      id: "plan_step_task_001_stop",
      kind: "stop",
      stopReason: "User input is not a network target.",
    });
  });

  it("rejects unknown NetDoctor tools", () => {
    expect(() =>
      parseNetDoctorProviderResponse(
        createProviderResponse({
          kind: "callTool",
          toolName: "shell.runCommand",
        }),
        createPlannerInput(),
      ),
    ).toThrow("Provider selected unknown NetDoctor tool 'shell.runCommand'.");
  });
});

describe("createNetDoctorPlanner", () => {
  it("composes ProviderBackedPlanner with NetDoctor request and response adapters", async () => {
    const provider = new FakeProvider({
      responses: [
        createProviderResponse({
          kind: "callTool",
          toolName: "netDoctor.dnsLookup",
          reason: "Start with DNS.",
        }),
      ],
    });
    const planner = createNetDoctorPlanner(provider);

    const planStep = await planner.plan(createPlannerInput());

    expect(planStep).toMatchObject({
      kind: "callTool",
      toolCall: {
        id: "tool_call_dns_lookup",
        toolName: "netDoctor.dnsLookup",
      },
    });
    expect(provider.requests()[0]).toMatchObject({
      capability: "net-doctor.tool-planning",
      metadata: {
        product: "net-doctor",
        taskId: "task_001",
      },
    });
  });
});

function createPlannerInput(): PlannerInput {
  return {
    task: {
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: createTaskInput(),
      createdAt: "2026-06-07T00:00:00.000Z",
      metadata: {
        product: "net-doctor",
      },
    },
    context: createContext(),
    metadata: {},
  };
}

function createTaskInput(): NetDoctorInput & { toolCalls: ToolCall[] } {
  return {
    target: {
      raw: "https://example.com",
      host: "example.com",
      port: 443,
      protocol: "https",
      normalized: "https://example.com",
    },
    symptom: "Browser cannot reach the service.",
    toolCalls: [
      createToolCall("tool_call_dns_lookup", "netDoctor.dnsLookup"),
      createToolCall("tool_call_tcp_connect", "netDoctor.tcpConnect"),
      createToolCall("tool_call_http_reachability", "netDoctor.httpReachability"),
      createToolCall("tool_call_proxy_config", "netDoctor.proxyConfig"),
    ],
  };
}

function createToolCall(id: string, toolName: string): ToolCall {
  return {
    id,
    toolName,
    input: {
      target: "https://example.com",
      host: "example.com",
      port: 443,
      protocol: "https",
      symptom: "Browser cannot reach the service.",
    },
    risk: "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}

function createContext(): ContextSnapshot {
  return {
    taskId: "task_001",
    messages: [],
    observations: [
      {
        id: "observation_dns",
        source: {
          kind: "toolResult",
          id: "tool_call_dns_lookup",
          metadata: {},
        },
        summary: "DNS lookup returned one address.",
        toolResultRef: "tool_call_dns_lookup",
        evidenceRefs: ["evidence_dns"],
        metadata: {},
      },
      {
        id: "observation_proxy",
        source: {
          kind: "toolResult",
          id: "tool_call_proxy_config",
          metadata: {},
        },
        summary: "Proxy environment configuration is present.",
        toolResultRef: "tool_call_proxy_config",
        evidenceRefs: ["evidence_proxy"],
        metadata: {},
      },
    ],
    evidenceRefs: ["evidence_dns", "evidence_proxy"],
    metadata: {},
  };
}

function createProviderResponse(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}
