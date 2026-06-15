import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";

export function createDesktopDemoProvider(): Provider {
  return createQueuedDesktopDemoProvider(
    [
      providerOutput({
        kind: "callTool",
        toolName: "netDoctor.dnsLookup",
        reason: "Start desktop diagnosis with DNS lookup.",
      }),
      providerOutput({
        kind: "callTool",
        toolName: "netDoctor.tcpConnect",
        reason: "Use DNS evidence to test TCP connectivity.",
      }),
      providerOutput({
        kind: "final",
        finalOutput: {
          conclusion: "Desktop demo provider completed the core NetDoctor checks.",
        },
      }),
    ],
  );
}

function createQueuedDesktopDemoProvider(responses: ProviderResponse[]): Provider {
  return {
    capabilities: {
      id: "net-doctor-desktop-demo-provider",
      name: "NetDoctor Desktop Demo Provider",
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
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
            message: "Desktop demo provider has no queued response.",
          },
          metadata: {
            providerId: "net-doctor-desktop-demo-provider",
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
      providerId: "net-doctor-desktop-demo-provider",
    },
  };
}
