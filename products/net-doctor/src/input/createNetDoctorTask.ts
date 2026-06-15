import type { AgentTask } from "@agent-anything/agent-core";
import type { ToolCall } from "@agent-anything/tools";
import type { NetDoctorInput } from "./NetDoctorInput.js";
import { parseSymptom } from "./SymptomParser.js";
import { parseTarget } from "./TargetParser.js";

export interface CreateNetDoctorTaskInput {
  target: string;
  symptom?: string;
  taskId?: string;
  createdAt?: string;
  source?: string;
}

export function createNetDoctorTask(
  input: CreateNetDoctorTaskInput,
): AgentTask<NetDoctorInput & { toolCalls: ToolCall[] }> {
  const target = parseTarget(input.target);
  const symptom = parseSymptom(input.symptom);
  const taskId = input.taskId ?? createTaskId();

  return {
    id: taskId,
    kind: "net-doctor.diagnose",
    input: {
      target,
      symptom,
      toolCalls: createPhase1ToolCalls(taskId, {
        target: target.normalized,
        host: target.host,
        port: target.port,
        protocol: target.protocol,
        symptom,
      }),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
    metadata: {
      product: "net-doctor",
      source: input.source ?? "net-doctor",
    },
  };
}

function createPhase1ToolCalls(
  taskId: string,
  input: {
    target: string;
    host: string;
    port: number | null;
    protocol: string | null;
    symptom: string;
  },
): ToolCall[] {
  return [
    createToolCall(taskId, "tool_call_dns_lookup", "netDoctor.dnsLookup", input),
    createToolCall(taskId, "tool_call_tcp_connect", "netDoctor.tcpConnect", input),
    createToolCall(
      taskId,
      "tool_call_http_reachability",
      "netDoctor.httpReachability",
      input,
    ),
    createToolCall(taskId, "tool_call_proxy_config", "netDoctor.proxyConfig", input),
  ];
}

function createToolCall(
  taskId: string,
  id: string,
  toolName: string,
  input: {
    target: string;
    host: string;
    port: number | null;
    protocol: string | null;
    symptom: string;
  },
): ToolCall {
  return {
    id,
    toolName,
    input,
    risk: "safe",
    metadata: {
      taskId,
      source: "net-doctor-task-input",
    },
  };
}

function createTaskId(): string {
  return `task_${Date.now()}`;
}
