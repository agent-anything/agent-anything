import * as http from "node:http";
import * as https from "node:https";
import type { ToolDefinition } from "@agent-anything/tools";
import { readNetDoctorToolInput } from "./input.js";
import type { HttpReachabilityOutput, NetDoctorToolInput } from "./toolSchemas.js";
import { createFailedToolResult, createSucceededToolResult } from "./toolResult.js";

const DEFAULT_TIMEOUT_MS = 5000;

export function createHttpReachabilityTool(): ToolDefinition<
  NetDoctorToolInput,
  HttpReachabilityOutput
> {
  return {
    name: "netDoctor.httpReachability",
    description: "Check HTTP or HTTPS reachability for a target.",
    risk: "safe",
    async execute(call) {
      try {
        const input = readNetDoctorToolInput(call);
        const url = createUrl(input);
        const result = await requestHead(url, DEFAULT_TIMEOUT_MS);

        return createSucceededToolResult(call, {
          url,
          reachable: result.statusCode !== null && result.statusCode < 500,
          statusCode: result.statusCode,
          statusMessage: result.statusMessage,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        return createFailedToolResult<HttpReachabilityOutput>(
          call,
          "http_reachability_failed",
          error instanceof Error ? error.message : "HTTP reachability check failed.",
        );
      }
    },
  };
}

function createUrl(input: NetDoctorToolInput): string {
  const protocol = input.protocol === "http" || input.protocol === "https"
    ? input.protocol
    : "https";
  const port = input.port === null ? "" : `:${input.port}`;

  return `${protocol}://${input.host}${port}/`;
}

function requestHead(
  url: string,
  timeoutMs: number,
): Promise<{ statusCode: number | null; statusMessage: string | null }> {
  return new Promise((resolve) => {
    const client = url.startsWith("https://") ? https : http;
    const request = client.request(
      url,
      {
        method: "HEAD",
        timeout: timeoutMs,
      },
      (response) => {
        const statusCode = response.statusCode ?? null;
        const statusMessage = response.statusMessage ?? null;
        response.resume();
        resolve({ statusCode, statusMessage });
      },
    );

    request.on("error", () => {
      resolve({ statusCode: null, statusMessage: null });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("HTTP reachability check timed out."));
      resolve({ statusCode: null, statusMessage: null });
    });
    request.end();
  });
}
