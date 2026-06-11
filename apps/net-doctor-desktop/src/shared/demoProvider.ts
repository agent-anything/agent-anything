import { FakeProvider, type Provider } from "@agent-anything/platform";

export function createDesktopDemoProvider(): Provider {
  return new FakeProvider({
    responses: [
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
  });
}

function providerOutput(output: unknown) {
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
