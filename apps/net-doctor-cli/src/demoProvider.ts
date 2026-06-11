import { FakeProvider, type Provider } from "@agent-anything/platform";

export function createDemoNetDoctorProvider(): Provider {
  return new FakeProvider({
    responses: [
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
  });
}

function providerOutput(output: unknown) {
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
