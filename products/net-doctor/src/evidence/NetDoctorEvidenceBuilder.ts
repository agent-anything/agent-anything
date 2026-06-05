import type {
  BuildEvidenceInput,
  Evidence,
  EvidenceSensitivity,
  ToolResult,
} from "@agent-anything/platform";
import type {
  DnsLookupOutput,
  HttpReachabilityOutput,
  ProxyConfigOutput,
  TcpConnectOutput,
} from "../tools/index.js";

export class NetDoctorEvidenceBuilder {
  buildFromToolResult(input: BuildEvidenceInput): Evidence[] {
    const { toolResult } = input;
    const evidence = createEvidence(toolResult);

    if (evidence === null) {
      return [];
    }

    return [
      {
        id: input.id ?? `evidence_${toolResult.toolCallId}`,
        source: {
          kind: "toolResult",
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          metadata: toolResult.metadata,
        },
        summary: input.summary ?? evidence.summary,
        content: evidence.content,
        sensitivity: input.sensitivity ?? evidence.sensitivity,
        metadata: {
          evidenceKind: evidence.kind,
          createdFrom: toolResult.toolCallId,
          ...input.metadata,
        },
      },
    ];
  }
}

function createEvidence(
  toolResult: ToolResult,
): {
  kind: string;
  summary: string;
  content: unknown;
  sensitivity: EvidenceSensitivity;
} | null {
  if (toolResult.status === "failed") {
    return {
      kind: "toolFailure",
      summary: `${toToolLabel(toolResult.toolName)} failed: ${toolResult.error?.message ?? "unknown error"}.`,
      content: {
        status: toolResult.status,
        error: toolResult.error,
      },
      sensitivity: "normal",
    };
  }

  switch (toolResult.toolName) {
    case "netDoctor.dnsLookup":
      return mapDnsEvidence(readOutput<DnsLookupOutput>(toolResult));
    case "netDoctor.tcpConnect":
      return mapTcpEvidence(readOutput<TcpConnectOutput>(toolResult));
    case "netDoctor.httpReachability":
      return mapHttpEvidence(readOutput<HttpReachabilityOutput>(toolResult));
    case "netDoctor.proxyConfig":
      return mapProxyEvidence(readOutput<ProxyConfigOutput>(toolResult));
    default:
      return {
        kind: "genericToolResult",
        summary: `Evidence from ${toolResult.toolName}.`,
        content: toolResult.output,
        sensitivity: "normal",
      };
  }
}

function mapDnsEvidence(output: DnsLookupOutput) {
  const addressCount = output.addresses.length;
  const summary =
    addressCount === 0
      ? `${output.host} resolved with no returned addresses.`
      : `${output.host} resolved to ${addressCount} address${addressCount === 1 ? "" : "es"}.`;

  return {
    kind: "dnsLookup",
    summary,
    content: output,
    sensitivity: "normal" as const,
  };
}

function mapTcpEvidence(output: TcpConnectOutput) {
  return {
    kind: "tcpConnect",
    summary: output.reachable
      ? `TCP ${output.host}:${output.port} is reachable.`
      : `TCP ${output.host}:${output.port} did not connect within ${output.timeoutMs}ms.`,
    content: output,
    sensitivity: "normal" as const,
  };
}

function mapHttpEvidence(output: HttpReachabilityOutput) {
  const status = output.statusCode === null
    ? "no HTTP status"
    : `HTTP ${output.statusCode}${output.statusMessage ? ` ${output.statusMessage}` : ""}`;

  return {
    kind: "httpReachability",
    summary: output.reachable
      ? `${output.url} is reachable (${status}).`
      : `${output.url} is not reachable (${status}).`,
    content: output,
    sensitivity: "normal" as const,
  };
}

function mapProxyEvidence(output: ProxyConfigOutput) {
  const configuredVariables = output.variables
    .filter((variable) => variable.configured)
    .map((variable) => variable.name);

  return {
    kind: "proxyConfig",
    summary: output.hasProxy
      ? `Proxy environment configuration is present (${configuredVariables.join(", ")}).`
      : "No proxy environment variables are configured.",
    content: output,
    sensitivity: output.hasProxy ? "sensitive" as const : "normal" as const,
  };
}

function readOutput<TOutput>(toolResult: ToolResult): TOutput {
  return toolResult.output as TOutput;
}

function toToolLabel(toolName: string): string {
  switch (toolName) {
    case "netDoctor.dnsLookup":
      return "DNS lookup";
    case "netDoctor.tcpConnect":
      return "TCP connectivity check";
    case "netDoctor.httpReachability":
      return "HTTP reachability check";
    case "netDoctor.proxyConfig":
      return "Proxy configuration check";
    default:
      return toolName;
  }
}
