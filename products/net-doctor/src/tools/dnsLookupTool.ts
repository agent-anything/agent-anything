import { lookup } from "node:dns/promises";
import type { ToolDefinition } from "@agent-anything/platform";
import { readNetDoctorToolInput } from "./input.js";
import type { DnsLookupOutput, NetDoctorToolInput } from "./toolSchemas.js";
import { createFailedToolResult, createSucceededToolResult } from "./toolResult.js";

export function createDnsLookupTool(): ToolDefinition<NetDoctorToolInput, DnsLookupOutput> {
  return {
    name: "netDoctor.dnsLookup",
    description: "Resolve DNS addresses for a target host.",
    risk: "safe",
    async execute(call) {
      try {
        const input = readNetDoctorToolInput(call);
        const addresses = await lookup(input.host, { all: true });

        return createSucceededToolResult(call, {
          host: input.host,
          addresses,
        });
      } catch (error) {
        return createFailedToolResult<DnsLookupOutput>(
          call,
          "dns_lookup_failed",
          error instanceof Error ? error.message : "DNS lookup failed.",
        );
      }
    },
  };
}
