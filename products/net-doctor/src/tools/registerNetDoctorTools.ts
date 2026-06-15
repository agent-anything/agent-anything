import type { ToolRegistry } from "@agent-anything/tools";
import { createDnsLookupTool } from "./dnsLookupTool.js";
import { createHttpReachabilityTool } from "./httpReachabilityTool.js";
import { createProxyConfigTool } from "./proxyConfigTool.js";
import { createTcpConnectTool } from "./tcpConnectTool.js";

export function registerNetDoctorTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createDnsLookupTool());
  toolRegistry.register(createTcpConnectTool());
  toolRegistry.register(createHttpReachabilityTool());
  toolRegistry.register(createProxyConfigTool());
}
