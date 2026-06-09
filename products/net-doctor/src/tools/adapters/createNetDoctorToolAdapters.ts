import type { ToolAdapter } from "@agent-anything/platform";
import { createDnsLookupTool } from "../dnsLookupTool.js";
import { createHttpReachabilityTool } from "../httpReachabilityTool.js";
import { createProxyConfigTool } from "../proxyConfigTool.js";
import { createTcpConnectTool } from "../tcpConnectTool.js";
import { NetDoctorToolDefinitionAdapter } from "./netDoctorToolDefinitionAdapter.js";

export function createNetDoctorToolAdapters(): ToolAdapter[] {
  return [
    new NetDoctorToolDefinitionAdapter(createDnsLookupTool()),
    new NetDoctorToolDefinitionAdapter(createTcpConnectTool()),
    new NetDoctorToolDefinitionAdapter(createHttpReachabilityTool()),
    new NetDoctorToolDefinitionAdapter(createProxyConfigTool()),
  ];
}
