import {
  FakeProvider,
  InMemoryStorage,
  RuntimeEventEmitter,
  RuntimeEventRecorder,
  ToolRegistry,
  type ProviderResponse,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@agent-anything/platform";
import { describe, expect, it } from "vitest";
import { createNetDoctorTask } from "../../input/index.js";
import { createNetDoctorAgentRuntime } from "./createNetDoctorAgentRuntime.js";

describe("createNetDoctorAgentRuntime", () => {
  it("runs fake provider callTool then final through the Phase2 runtime path", async () => {
    const provider = new FakeProvider({
      responses: [
        createProviderResponse({
          kind: "callTool",
          toolName: "netDoctor.dnsLookup",
          reason: "Start with DNS.",
        }),
        createProviderResponse({
          kind: "final",
          finalOutput: {
            conclusion: "DNS resolved successfully.",
          },
          reason: "DNS evidence is enough for this test.",
        }),
      ],
    });
    const storage = new InMemoryStorage();
    const eventEmitter = new RuntimeEventEmitter();
    const recorder = new RuntimeEventRecorder();
    recorder.attachTo(eventEmitter);

    const runtime = createNetDoctorAgentRuntime({
      provider,
      storage,
      eventEmitter,
      toolRegistry: createFakeToolRegistry(),
      limits: {
        maxIterations: 3,
      },
      metadata: {
        testRun: "phase2-runtime-composition",
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      taskId: "task_001",
      status: "succeeded",
      reportRef: "artifact_report_report_task_001",
      evidenceRefs: ["evidence_tool_call_dns_lookup"],
      errors: [],
      metadata: {
        product: "net-doctor",
        runtime: "phase2-agent",
        testRun: "phase2-runtime-composition",
      },
    });
    expect(storage.getEvidence("evidence_tool_call_dns_lookup")).toMatchObject({
      summary: "example.com resolved to 1 address.",
      metadata: {
        evidenceKind: "dnsLookup",
      },
    });
    const report = storage.getReport("report_task_001");
    expect(report).toMatchObject({
      title: "NetDoctor diagnosis for example.com",
      evidenceRefs: ["evidence_tool_call_dns_lookup"],
      metadata: {
        product: "net-doctor",
        template: "summary",
      },
    });
    expect(report?.sections[0]).toMatchObject({
      title: "Diagnosis",
      content: expect.stringContaining("Conclusion: DNS resolved successfully."),
      evidenceRefs: ["evidence_tool_call_dns_lookup"],
    });
    expect(report?.sections[1]).toMatchObject({
      title: "Evidence Summary",
      content: "- example.com resolved to 1 address.",
      evidenceRefs: ["evidence_tool_call_dns_lookup"],
    });
    expect(provider.requests()).toHaveLength(2);
    expect(provider.requests()[1]?.messages[1]?.content).toContain(
      "example.com resolved to 1 address.",
    );
    expect(recorder.names()).toContain("context.updated");
  });
});

function createTask() {
  return createNetDoctorTask({
    target: "https://example.com",
    symptom: "Browser cannot reach the service.",
    taskId: "task_001",
    createdAt: "2026-06-08T00:00:00.000Z",
  });
}

function createFakeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createFakeDnsTool());
  return registry;
}

function createFakeDnsTool(): ToolDefinition {
  return {
    name: "netDoctor.dnsLookup",
    description: "Fake DNS lookup.",
    risk: "safe",
    async execute(call) {
      return createDnsToolResult(call);
    },
  };
}

function createDnsToolResult(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "succeeded",
    output: {
      host: "example.com",
      addresses: [
        {
          address: "93.184.216.34",
          family: 4,
        },
      ],
    },
    error: null,
    startedAt: "2026-06-08T00:00:00.000Z",
    finishedAt: "2026-06-08T00:00:01.000Z",
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
