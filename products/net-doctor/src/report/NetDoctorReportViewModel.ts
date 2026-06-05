import type { RuntimeResult } from "@agent-anything/platform";
import type { NetDoctorInput } from "../input/index.js";

export interface NetDoctorReportViewModel {
  status: RuntimeResult["status"];
  target: string;
  symptom: string;
  checks: NetDoctorReportCheck[];
  evidenceRefs: string[];
  artifactRefs: string[];
  reportRef: string | null;
  conclusion: string;
  nextSteps: string[];
  errors: Array<{
    code: string;
    message: string;
  }>;
}

export interface NetDoctorReportCheck {
  name: string;
  toolName: string;
}

export function createNetDoctorReportViewModel(input: {
  taskInput: NetDoctorInput & {
    toolCalls: Array<{
      toolName: string;
    }>;
  };
  result: RuntimeResult;
}): NetDoctorReportViewModel {
  const checks = input.taskInput.toolCalls.map((toolCall) => ({
    name: toCheckName(toolCall.toolName),
    toolName: toolCall.toolName,
  }));

  return {
    status: input.result.status,
    target: input.taskInput.target.normalized,
    symptom: input.taskInput.symptom,
    checks,
    evidenceRefs: input.result.evidenceRefs,
    artifactRefs: input.result.artifactRefs,
    reportRef: input.result.reportRef,
    conclusion: createConclusion(input.result.status),
    nextSteps: createNextSteps(input.result.status),
    errors: input.result.errors.map((error) => ({
      code: error.code,
      message: error.message,
    })),
  };
}

function toCheckName(toolName: string): string {
  switch (toolName) {
    case "netDoctor.dnsLookup":
      return "DNS lookup";
    case "netDoctor.tcpConnect":
      return "TCP connectivity";
    case "netDoctor.httpReachability":
      return "HTTP reachability";
    case "netDoctor.proxyConfig":
      return "Proxy configuration";
    default:
      return toolName;
  }
}

function createConclusion(status: RuntimeResult["status"]): string {
  if (status === "succeeded") {
    return "NetDoctor completed the Phase1 diagnosis flow.";
  }

  return "NetDoctor could not complete the Phase1 diagnosis flow.";
}

function createNextSteps(status: RuntimeResult["status"]): string[] {
  if (status === "succeeded") {
    return [
      "Review the checks performed.",
      "Inspect evidence and artifact references when deeper debugging is needed.",
      "Run the diagnosis again after changing local network or proxy settings.",
    ];
  }

  return [
    "Review the error section.",
    "Check whether the target is valid and reachable from this machine.",
    "Run the diagnosis again after correcting the input or network state.",
  ];
}
