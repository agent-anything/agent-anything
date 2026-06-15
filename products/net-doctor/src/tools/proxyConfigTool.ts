import type { ToolDefinition } from "@agent-anything/tools";
import { readNetDoctorToolInput } from "./input.js";
import type { NetDoctorToolInput, ProxyConfigOutput } from "./toolSchemas.js";
import { createFailedToolResult, createSucceededToolResult } from "./toolResult.js";

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function createProxyConfigTool(): ToolDefinition<
  NetDoctorToolInput,
  ProxyConfigOutput
> {
  return {
    name: "netDoctor.proxyConfig",
    description: "Summarize local proxy environment configuration.",
    risk: "safe",
    async execute(call) {
      try {
        readNetDoctorToolInput(call);
        const variables = PROXY_ENV_NAMES.map((name) => ({
          name,
          configured: Boolean(process.env[name]),
        }));

        return createSucceededToolResult(call, {
          hasProxy: variables.some((variable) => variable.configured),
          variables,
        });
      } catch (error) {
        return createFailedToolResult<ProxyConfigOutput>(
          call,
          "proxy_config_failed",
          error instanceof Error ? error.message : "Proxy config check failed.",
        );
      }
    },
  };
}
