import { describe, expect, it } from "vitest";
import { createDefaultRuntime } from "@agent-anything/agent-core";
import { InMemoryStorage } from "@agent-anything/storage";
import { ToolRegistry, type ToolCall, type ToolDefinition, type ToolResult } from "@agent-anything/tools";
import type { Evidence } from "@agent-anything/evidence";
import { NetDoctorEvidenceBuilder } from "../evidence/index.js";
import { createNetDoctorTask } from "../input/index.js";
import { createNetDoctorReportViewModel } from "../report/NetDoctorReportViewModel.js";

interface NetDoctorPhase1Scenario {
  id: string;
  target: string;
  symptom: string;
  mockOutputs: Record<string, unknown>;
  expectedEvidenceSummaries: string[];
  expectedConclusionKeywords: string[];
  expectedNextStepKeywords: string[];
  forbiddenTools: string[];
}

const EXPECTED_PHASE1_TOOLS = [
  "netDoctor.dnsLookup",
  "netDoctor.tcpConnect",
  "netDoctor.httpReachability",
  "netDoctor.proxyConfig",
];

const scenarios: NetDoctorPhase1Scenario[] = [
  {
    id: "dns_lookup_returns_no_addresses",
    target: "internal.example.local",
    symptom: "I cannot open internal.example.local and suspect DNS.",
    mockOutputs: {
      "netDoctor.dnsLookup": {
        host: "internal.example.local",
        addresses: [],
      },
      "netDoctor.tcpConnect": {
        host: "internal.example.local",
        port: 443,
        reachable: false,
        timeoutMs: 3000,
      },
      "netDoctor.httpReachability": {
        url: "https://internal.example.local/",
        reachable: false,
        statusCode: null,
        statusMessage: null,
        timeoutMs: 5000,
      },
      "netDoctor.proxyConfig": noProxyOutput(),
    },
    expectedEvidenceSummaries: [
      "internal.example.local resolved with no returned addresses.",
    ],
    expectedConclusionKeywords: ["DNS resolution", "without returned addresses"],
    expectedNextStepKeywords: ["VPN", "enterprise DNS"],
    forbiddenTools: ["netDoctor.packetCapture", "netDoctor.setDns"],
  },
  {
    id: "dns_ok_but_tcp_unreachable",
    target: "example.com",
    symptom: "example.com resolves but the website does not open.",
    mockOutputs: {
      "netDoctor.dnsLookup": {
        host: "example.com",
        addresses: [{ address: "93.184.216.34", family: 4 }],
      },
      "netDoctor.tcpConnect": {
        host: "example.com",
        port: 443,
        reachable: false,
        timeoutMs: 3000,
      },
      "netDoctor.httpReachability": {
        url: "https://example.com/",
        reachable: false,
        statusCode: null,
        statusMessage: null,
        timeoutMs: 5000,
      },
      "netDoctor.proxyConfig": noProxyOutput(),
    },
    expectedEvidenceSummaries: [
      "example.com resolved to 1 address.",
      "TCP example.com:443 did not connect within 3000ms.",
    ],
    expectedConclusionKeywords: ["TCP connectivity did not complete", "firewall"],
    expectedNextStepKeywords: ["target service is listening"],
    forbiddenTools: ["netDoctor.setDns"],
  },
  {
    id: "proxy_environment_present",
    target: "example.com",
    symptom: "Browser works but command-line requests may not use proxy.",
    mockOutputs: {
      "netDoctor.dnsLookup": {
        host: "example.com",
        addresses: [{ address: "93.184.216.34", family: 4 }],
      },
      "netDoctor.tcpConnect": {
        host: "example.com",
        port: 443,
        reachable: true,
        timeoutMs: 3000,
      },
      "netDoctor.httpReachability": {
        url: "https://example.com/",
        reachable: true,
        statusCode: 200,
        statusMessage: "OK",
        timeoutMs: 5000,
      },
      "netDoctor.proxyConfig": {
        hasProxy: true,
        variables: [
          { name: "HTTPS_PROXY", configured: true },
          { name: "NO_PROXY", configured: false },
        ],
      },
    },
    expectedEvidenceSummaries: [
      "Proxy environment configuration is present (HTTPS_PROXY).",
    ],
    expectedConclusionKeywords: ["proxy environment configuration is present"],
    expectedNextStepKeywords: ["command-line tools"],
    forbiddenTools: ["netDoctor.setProxy"],
  },
  {
    id: "local_service_port_unreachable",
    target: "localhost:3000",
    symptom: "A local development server on port 3000 is not reachable.",
    mockOutputs: {
      "netDoctor.dnsLookup": {
        host: "localhost",
        addresses: [{ address: "127.0.0.1", family: 4 }],
      },
      "netDoctor.tcpConnect": {
        host: "localhost",
        port: 3000,
        reachable: false,
        timeoutMs: 3000,
      },
      "netDoctor.httpReachability": {
        url: "http://localhost:3000/",
        reachable: false,
        statusCode: null,
        statusMessage: null,
        timeoutMs: 5000,
      },
      "netDoctor.proxyConfig": noProxyOutput(),
    },
    expectedEvidenceSummaries: [
      "TCP localhost:3000 did not connect within 3000ms.",
    ],
    expectedConclusionKeywords: ["TCP connectivity did not complete"],
    expectedNextStepKeywords: ["target service is listening"],
    forbiddenTools: ["netDoctor.openFirewall"],
  },
  {
    id: "basic_checks_all_pass",
    target: "https://example.com",
    symptom: "Check whether the basic connection path is healthy.",
    mockOutputs: {
      "netDoctor.dnsLookup": {
        host: "example.com",
        addresses: [{ address: "93.184.216.34", family: 4 }],
      },
      "netDoctor.tcpConnect": {
        host: "example.com",
        port: 443,
        reachable: true,
        timeoutMs: 3000,
      },
      "netDoctor.httpReachability": {
        url: "https://example.com/",
        reachable: true,
        statusCode: 200,
        statusMessage: "OK",
        timeoutMs: 5000,
      },
      "netDoctor.proxyConfig": noProxyOutput(),
    },
    expectedEvidenceSummaries: [
      "example.com resolved to 1 address.",
      "TCP example.com:443 is reachable.",
      "https://example.com/ is reachable (HTTP 200 OK).",
    ],
    expectedConclusionKeywords: ["did not find an obvious DNS, TCP, HTTP, or proxy blocker"],
    expectedNextStepKeywords: ["Review the evidence summaries"],
    forbiddenTools: ["netDoctor.packetCapture", "netDoctor.setDns", "netDoctor.setProxy"],
  },
];

describe("NetDoctor Phase1 mock scenarios", () => {
  for (const scenario of scenarios) {
    it(`runs scenario: ${scenario.id}`, async () => {
      const executedTools: string[] = [];
      const task = createNetDoctorTask({
        target: scenario.target,
        symptom: scenario.symptom,
        taskId: `task_${scenario.id}`,
        createdAt: "2026-06-06T00:00:00.000Z",
      });
      const storage = new InMemoryStorage();
      const registry = createMockRegistry({
        outputs: scenario.mockOutputs,
        executedTools,
      });
      const runtime = createDefaultRuntime({
        toolRegistry: registry,
        permissionMode: "trusted",
        storage,
        evidenceBuilder: new NetDoctorEvidenceBuilder(),
        metadata: {
          source: "net-doctor-phase1-scenario-test",
        },
      });

      const result = await runtime.run(task);
      const evidence = result.evidenceRefs
        .map((id) => storage.getEvidence(id))
        .filter((item): item is Evidence => item !== undefined);
      const reportModel = createNetDoctorReportViewModel({
        taskInput: task.input,
        result,
        evidence,
      });

      expect(result.status).toBe("succeeded");
      expect(executedTools).toEqual(EXPECTED_PHASE1_TOOLS);
      for (const forbiddenTool of scenario.forbiddenTools) {
        expect(executedTools).not.toContain(forbiddenTool);
      }
      for (const expectedSummary of scenario.expectedEvidenceSummaries) {
        expect(evidence.map((item) => item.summary)).toContain(expectedSummary);
      }
      for (const keyword of scenario.expectedConclusionKeywords) {
        expect(reportModel.conclusion).toContain(keyword);
      }
      for (const keyword of scenario.expectedNextStepKeywords) {
        expect(reportModel.nextSteps.join("\n")).toContain(keyword);
      }
      expect(reportModel.evidence).toHaveLength(EXPECTED_PHASE1_TOOLS.length);
    });
  }
});

function createMockRegistry(input: {
  outputs: Record<string, unknown>;
  executedTools: string[];
}): ToolRegistry {
  const registry = new ToolRegistry();

  for (const toolName of EXPECTED_PHASE1_TOOLS) {
    registry.register(createMockTool(toolName, input));
  }

  return registry;
}

function createMockTool(
  toolName: string,
  input: {
    outputs: Record<string, unknown>;
    executedTools: string[];
  },
): ToolDefinition {
  return {
    name: toolName,
    description: `Mock ${toolName} for NetDoctor Phase1 scenario tests.`,
    risk: "safe",
    async execute(call) {
      input.executedTools.push(call.toolName);
      return createSucceededToolResult(call, input.outputs[call.toolName]);
    },
  };
}

function createSucceededToolResult(
  call: ToolCall,
  output: unknown,
): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "succeeded",
    output,
    error: null,
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:01.000Z",
    metadata: call.metadata,
  };
}

function noProxyOutput() {
  return {
    hasProxy: false,
    variables: [
      { name: "HTTP_PROXY", configured: false },
      { name: "HTTPS_PROXY", configured: false },
      { name: "NO_PROXY", configured: false },
      { name: "http_proxy", configured: false },
      { name: "https_proxy", configured: false },
      { name: "no_proxy", configured: false },
    ],
  };
}
