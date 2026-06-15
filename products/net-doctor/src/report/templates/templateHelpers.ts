import type { Evidence } from "@agent-anything/evidence";
import type { NetDoctorInput } from "../../input/index.js";
import type { TemplateRenderInput } from "./ReportTemplate.js";

export function getNetDoctorInput(input: TemplateRenderInput): Partial<NetDoctorInput> {
  if (!isRecord(input.task.input)) {
    return {};
  }

  return input.task.input as Partial<NetDoctorInput>;
}

export function getTargetLabel(input: TemplateRenderInput): string {
  const taskInput = getNetDoctorInput(input);

  return taskInput.target?.normalized ?? input.task.id;
}

export function getSymptom(input: TemplateRenderInput): string {
  const taskInput = getNetDoctorInput(input);

  return taskInput.symptom?.trim() || "(none)";
}

export function getEvidenceRefs(evidence: Evidence[]): string[] {
  return evidence.map((item) => item.id);
}

export function getEvidenceKind(evidence: Evidence): string {
  return typeof evidence.metadata.evidenceKind === "string"
    ? evidence.metadata.evidenceKind
    : "unknown";
}

export function getFinalDiagnosis(finalOutput: unknown): string {
  if (typeof finalOutput === "string" && finalOutput.trim() !== "") {
    return finalOutput;
  }

  if (!isRecord(finalOutput)) {
    return "No final diagnosis was provided.";
  }

  const value =
    readString(finalOutput, "diagnosis") ??
    readString(finalOutput, "conclusion") ??
    readString(finalOutput, "summary");

  return value ?? "No final diagnosis was provided.";
}

export function createEvidenceSummary(evidence: Evidence[]): string {
  if (evidence.length === 0) {
    return "No evidence was produced.";
  }

  return evidence
    .map((item) => {
      const sensitivity = item.sensitivity === "public"
        ? ""
        : ` (${item.sensitivity})`;

      return `- ${item.summary}${sensitivity}`;
    })
    .join("\n");
}

export function toEvidenceTitle(evidenceKind: string): string {
  switch (evidenceKind) {
    case "dnsLookup":
      return "DNS lookup evidence";
    case "tcpConnect":
      return "TCP connectivity evidence";
    case "httpReachability":
      return "HTTP reachability evidence";
    case "proxyConfig":
      return "Proxy configuration evidence";
    default:
      return "Network evidence";
  }
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" && value[key].trim() !== ""
    ? value[key]
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
