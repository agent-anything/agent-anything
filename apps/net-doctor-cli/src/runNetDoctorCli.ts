import { InMemoryStorage } from "@agent-anything/storage";
import { RuntimeEventEmitter, defaultRuntimeLimits, type RuntimeResult } from "@agent-anything/agent-core";
import {
  createHostIdentityProvider,
  createHostPermissionService,
  createHostRunResult,
  createHostWorkspaceResolver,
  mapRuntimeEventToHostEvent,
  type HostEvent,
  type HostRunResult,
  type HostRuntimeAdapter,
} from "@agent-anything/agent-core/host";
import type { Evidence } from "@agent-anything/evidence";
import type { Provider } from "@agent-anything/providers";
import {
  createNetDoctorAgentRuntime,
  createNetDoctorReportViewModel,
  createNetDoctorTask,
  mapRuntimeEventToNetDoctorProgress,
  type NetDoctorInput,
} from "net-doctor";
import { createDemoNetDoctorProvider } from "./demoProvider.js";
import type { NetDoctorCliArgs } from "./parseCliArgs.js";

export interface RunNetDoctorCliInput {
  args: NetDoctorCliArgs;
  provider?: Provider;
  write?: (line: string) => void;
}

export interface RunNetDoctorCliResult {
  status: RuntimeResult["status"];
  exitCode: number;
  output: RuntimeResult["output"];
  evidenceRefs: string[];
  hostResult: HostRunResult;
  hostEvents: HostEvent[];
}

export async function runNetDoctorCli(
  input: RunNetDoctorCliInput,
): Promise<RunNetDoctorCliResult> {
  const write = input.write ?? console.log;
  const sessionId = `net-doctor-cli-${taskSafeId(input.args.target)}`;
  const hostEvents: HostEvent[] = [];
  const eventEmitter = new RuntimeEventEmitter();
  const storage = new InMemoryStorage();
  const provider = input.provider ?? createDemoNetDoctorProvider();
  const task = createNetDoctorTask({
    target: input.args.target,
    symptom: input.args.symptom,
    source: "net-doctor-cli",
  });

  eventEmitter.subscribe((event) => {
    hostEvents.push(mapRuntimeEventToHostEvent({
      sessionId,
      runtimeEvent: event,
    }));
    const update = mapRuntimeEventToNetDoctorProgress(event);
    if (update) {
      write(`[${update.phase}] ${update.message}`);
    }
  });

  const runtime = createNetDoctorAgentRuntime({
    provider,
    storage,
    eventEmitter,
    permissionMode: input.args.permissionMode,
    permissionService: input.args.permissionMode === "ask"
      ? createHostPermissionService({
        sessionId,
        bridge: async () => ({
          status: "granted",
          reason: "Granted by NetDoctor CLI host bridge.",
        }),
        eventSink: (event) => {
          hostEvents.push(event);
        },
        metadata: {
          host: "net-doctor-cli",
        },
      })
      : undefined,
    workspaceResolver: createHostWorkspaceResolver({
      workspace: {
        id: "net-doctor-cli-workspace",
        name: "NetDoctor CLI workspace",
        rootRef: null,
        trustState: "unknown",
        source: "net-doctor-cli",
        policyRefs: [],
        metadata: {},
      },
    }),
    identityProvider: createHostIdentityProvider({
      source: "net-doctor-cli",
    }),
  });
  const hostAdapter: HostRuntimeAdapter = {
    async run(hostInput) {
      const runtimeResult = await runtime.run(hostInput.task, hostInput.runtimeOptions);
      return createHostRunResult({
        sessionId: hostInput.sessionId,
        runtimeResult,
        cancellation: hostInput.cancellation,
        metadata: hostInput.metadata,
      });
    },
  };

  write(`NetDoctor diagnosis: ${input.args.target}`);

  const hostResult = await hostAdapter.run({
    sessionId,
    task,
    runtimeOptions: {
      limits: defaultRuntimeLimits,
      permissionMode: input.args.permissionMode,
      metadata: {
        product: "net-doctor",
        host: "net-doctor-cli",
      },
    },
    metadata: {
      host: "net-doctor-cli",
    },
  });
  const result: RuntimeResult = hostResult.runtimeResult!;
  const evidence = result.evidenceRefs
    .map((evidenceRef) => storage.getEvidence(evidenceRef))
    .filter((item): item is Evidence => item !== undefined);
  const viewModel = createNetDoctorReportViewModel({
    taskInput: task.input as NetDoctorInput & { toolCalls: Array<{ toolName: string }> },
    result,
    evidence,
  });

  write(`Result: ${result.status}`);
  write(`Conclusion: ${viewModel.conclusion}`);
  write(`Output: ${formatOutput(result.output)}`);

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      write(`Error: ${error.code}: ${error.message}`);
    }
  }

  return {
    status: result.status,
    exitCode: result.status === "succeeded" ? 0 : 1,
    output: result.output,
    evidenceRefs: result.evidenceRefs,
    hostResult,
    hostEvents,
  };
}

function formatOutput(output: unknown): string {
  return output === null ? "(none)" : JSON.stringify(output);
}

function taskSafeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
}
