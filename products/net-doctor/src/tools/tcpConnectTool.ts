import { createConnection } from "node:net";
import type { ToolDefinition } from "@agent-anything/tools";
import { readNetDoctorToolInput } from "./input.js";
import type { NetDoctorToolInput, TcpConnectOutput } from "./toolSchemas.js";
import { createFailedToolResult, createSucceededToolResult } from "./toolResult.js";

const DEFAULT_TIMEOUT_MS = 3000;

export function createTcpConnectTool(): ToolDefinition<NetDoctorToolInput, TcpConnectOutput> {
  return {
    name: "netDoctor.tcpConnect",
    description: "Check TCP connectivity for a target host and port.",
    risk: "safe",
    async execute(call) {
      try {
        const input = readNetDoctorToolInput(call);
        const port = input.port ?? inferPort(input.protocol);
        const reachable = await checkTcpConnect(input.host, port, DEFAULT_TIMEOUT_MS);

        return createSucceededToolResult(call, {
          host: input.host,
          port,
          reachable,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        return createFailedToolResult<TcpConnectOutput>(
          call,
          "tcp_connect_failed",
          error instanceof Error ? error.message : "TCP connect check failed.",
        );
      }
    },
  };
}

function inferPort(protocol: string | null): number {
  if (protocol === "https") {
    return 443;
  }

  return 80;
}

function checkTcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
