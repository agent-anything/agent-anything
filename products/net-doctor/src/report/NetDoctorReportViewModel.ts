import type { Evidence, RuntimeResult } from "@agent-anything/platform";
import type { NetDoctorInput } from "../input/index.js";

export interface NetDoctorReportViewModel {
  status: RuntimeResult["status"];
  target: string;
  symptom: string;
  checks: NetDoctorReportCheck[];
  evidence: NetDoctorReportEvidence[];
  evidenceRefs: string[];
  artifactRefs: string[];
  output: unknown;
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
  evidenceId: string | null;
  summary: string | null;
  sensitivity: Evidence["sensitivity"] | null;
}

export interface NetDoctorReportEvidence {
  id: string;
  toolName: string;
  evidenceKind: string;
  summary: string;
  sensitivity: Evidence["sensitivity"];
  content: unknown;
}

export function createNetDoctorReportViewModel(input: {
  taskInput: NetDoctorInput & {
    toolCalls: Array<{
      toolName: string;
    }>;
  };
  result: RuntimeResult;
  evidence?: Evidence[];
}): NetDoctorReportViewModel {
  const evidence = (input.evidence ?? []).map(toReportEvidence);
  const checks = input.taskInput.toolCalls.map((toolCall) => ({
    name: toCheckName(toolCall.toolName),
    toolName: toolCall.toolName,
    ...findCheckEvidence(toolCall.toolName, evidence),
  }));

  return {
    status: input.result.status,
    target: input.taskInput.target.normalized,
    symptom: input.taskInput.symptom,
    checks,
    evidence,
    evidenceRefs: input.result.evidenceRefs,
    artifactRefs: input.result.artifactRefs,
    output: input.result.output,
    conclusion: createConclusion({
      status: input.result.status,
      output: input.result.output,
      evidence,
      errors: input.result.errors,
    }),
    nextSteps: createNextSteps({
      status: input.result.status,
      evidence,
      errors: input.result.errors,
    }),
    errors: input.result.errors.map((error) => ({
      code: error.code,
      message: error.message,
    })),
  };
}

function toReportEvidence(evidence: Evidence): NetDoctorReportEvidence {
  return {
    id: evidence.id,
    toolName: evidence.source.toolName,
    evidenceKind: typeof evidence.metadata.evidenceKind === "string"
      ? evidence.metadata.evidenceKind
      : "unknown",
    summary: evidence.summary,
    sensitivity: evidence.sensitivity,
    content: evidence.content,
  };
}

function findCheckEvidence(
  toolName: string,
  evidence: NetDoctorReportEvidence[],
): Pick<NetDoctorReportCheck, "evidenceId" | "summary" | "sensitivity"> {
  const item = evidence.find((candidate) => candidate.toolName === toolName);

  return {
    evidenceId: item?.id ?? null,
    summary: item?.summary ?? null,
    sensitivity: item?.sensitivity ?? null,
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

function createConclusion(input: {
  status: RuntimeResult["status"];
  output: RuntimeResult["output"];
  evidence: NetDoctorReportEvidence[];
  errors: RuntimeResult["errors"];
}): string {
  if (input.status === "failed") {
    const firstError = input.errors[0];

    if (firstError) {
      return `NetDoctor could not complete the Phase1 diagnosis flow. The first blocking error was ${firstError.code}: ${firstError.message}`;
    }

    return "NetDoctor could not complete the Phase1 diagnosis flow.";
  }

  const outputConclusion = getOutputConclusion(input.output);
  if (outputConclusion) {
    return outputConclusion;
  }

  const dns = findEvidence(input.evidence, "dnsLookup");
  const tcp = findEvidence(input.evidence, "tcpConnect");
  const http = findEvidence(input.evidence, "httpReachability");
  const proxy = findEvidence(input.evidence, "proxyConfig");

  if (dns && getArrayLength(dns.content, "addresses") === 0) {
    return "Current evidence points first toward DNS resolution: the target lookup completed without returned addresses.";
  }

  if (tcp && getBoolean(tcp.content, "reachable") === false) {
    return "DNS evidence is available, but TCP connectivity did not complete. The issue is more likely connectivity, firewall, routing, or target service availability than name resolution.";
  }

  if (http && getBoolean(http.content, "reachable") === false) {
    return "Lower-level checks produced evidence, but HTTP did not return a reachable response. The issue may be at the HTTP service, proxy, TLS, or application layer.";
  }

  if (proxy && getBoolean(proxy.content, "hasProxy") === true) {
    return "Basic Phase1 checks completed and proxy environment configuration is present. Proxy settings may affect command-line or HTTP behavior.";
  }

  if (input.status === "succeeded") {
    return "NetDoctor completed the Phase1 diagnosis flow and did not find an obvious DNS, TCP, HTTP, or proxy blocker in the collected evidence.";
  }

  return "NetDoctor could not complete the Phase1 diagnosis flow.";
}

function getOutputConclusion(output: unknown): string | null {
  if (typeof output === "string" && output.trim() !== "") {
    return output;
  }

  if (!isRecord(output)) {
    return null;
  }

  return readString(output, "diagnosis") ??
    readString(output, "conclusion") ??
    readString(output, "summary");
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function createNextSteps(input: {
  status: RuntimeResult["status"];
  evidence: NetDoctorReportEvidence[];
  errors: RuntimeResult["errors"];
}): string[] {
  if (input.status === "failed") {
    return [
      "Review the error section.",
      "Check whether the target is valid and reachable from this machine.",
      "Run the diagnosis again after correcting the input or network state.",
    ];
  }

  const dns = findEvidence(input.evidence, "dnsLookup");
  const tcp = findEvidence(input.evidence, "tcpConnect");
  const http = findEvidence(input.evidence, "httpReachability");
  const proxy = findEvidence(input.evidence, "proxyConfig");

  if (dns && getArrayLength(dns.content, "addresses") === 0) {
    return [
      "Verify the target hostname is correct and expected to resolve from this network.",
      "Check whether VPN, enterprise DNS, or DNS suffix configuration is required for this target.",
      "Run the diagnosis again after DNS, VPN, or network changes.",
    ];
  }

  if (tcp && getBoolean(tcp.content, "reachable") === false) {
    return [
      "Verify the target service is listening on the expected port.",
      "Check local firewall, VPN, routing, and network policy between this machine and the target.",
      "Run the diagnosis again after network or service changes.",
    ];
  }

  if (http && getBoolean(http.content, "reachable") === false) {
    return [
      "Check whether the HTTP service is healthy and accepting requests.",
      "Review proxy, TLS, authentication, or application gateway settings.",
      "Compare with browser behavior or another HTTP client if the issue is intermittent.",
    ];
  }

  if (proxy && getBoolean(proxy.content, "hasProxy") === true) {
    return [
      "Confirm whether command-line tools should use the detected proxy environment variables.",
      "Compare browser proxy settings with shell environment proxy settings.",
      "Run the diagnosis again after changing proxy configuration.",
    ];
  }

  return [
    "Review the evidence summaries for each check.",
    "Inspect stored artifact references when deeper debugging is needed.",
    "Run the diagnosis again after changing local network, VPN, proxy, or target service settings.",
  ];
}

function findEvidence(
  evidence: NetDoctorReportEvidence[],
  evidenceKind: string,
): NetDoctorReportEvidence | undefined {
  return evidence.find((item) => item.evidenceKind === evidenceKind);
}

function getBoolean(content: unknown, key: string): boolean | null {
  if (!isRecord(content) || typeof content[key] !== "boolean") {
    return null;
  }

  return content[key];
}

function getArrayLength(content: unknown, key: string): number | null {
  if (!isRecord(content) || !Array.isArray(content[key])) {
    return null;
  }

  return content[key].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
