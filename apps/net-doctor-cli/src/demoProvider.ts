import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";

export function createDemoNetDoctorProvider(): Provider {
  return createQueuedDemoProvider(
    [
      providerOutput({
        kind: "callTool",
        toolName: "netDoctor.dnsLookup",
        reason: "Start with DNS lookup.",
      }),
      providerOutput({
        kind: "callTool",
        toolName: "netDoctor.tcpConnect",
        reason: "Use DNS evidence to test TCP connectivity.",
      }),
      providerOutput({
        kind: "callTool",
        toolName: "netDoctor.httpReachability",
        reason: "Check HTTP reachability after TCP.",
      }),
      providerOutput({
        kind: "callTool",
        toolName: "netDoctor.proxyConfig",
        reason: "Check whether proxy configuration may affect the diagnosis.",
      }),
      providerOutput({
        kind: "final",
        finalOutput: {
          conclusion: "Demo provider completed the planned NetDoctor checks.",
        },
      }),
    ],
  );
}

function createQueuedDemoProvider(responses: ProviderResponse[]): Provider {
  return {
    descriptor: {
      id: "net-doctor-demo-provider",
      name: "NetDoctor Demo Provider",
      capabilities: {
        supportsToolPlanning: true,
        supportsStructuredOutput: true,
        supportsStreaming: false,
      },
      metadata: {},
    },
    async send(_request: ProviderRequest) {
      const response = responses.shift();
      if (!response) {
        return {
          status: "failed",
          output: null,
          usage: null,
          error: {
            code: "provider_demo_exhausted",
            message: "Demo provider has no queued response.",
          },
          metadata: {
            providerId: "net-doctor-demo-provider",
          },
        };
      }

      return response;
    },
  };
}

function providerOutput(output: unknown): ProviderResponse {
  return {
    status: "succeeded" as const,
    output,
    usage: null,
    error: null,
    metadata: {
      providerId: "net-doctor-demo-provider",
    },
  };
}
