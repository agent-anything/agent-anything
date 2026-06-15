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
  type NetDoctorProgressUpdate,
} from "net-doctor";
import type {
  DesktopDiagnosisRequest,
  DesktopDiagnosisResult,
} from "./DesktopDiagnosis.js";
import { createDesktopDemoProvider } from "./demoProvider.js";

export interface RunDesktopDiagnosisInput {
  request: DesktopDiagnosisRequest;
  provider?: Provider;
}

export async function runDesktopDiagnosis(
  input: RunDesktopDiagnosisInput,
): Promise<DesktopDiagnosisResult> {
  const storage = new InMemoryStorage();
  const eventEmitter = new RuntimeEventEmitter();
  const progress: NetDoctorProgressUpdate[] = [];
  const sessionId = `net-doctor-desktop-${taskSafeId(input.request.target)}`;
  const hostEvents: HostEvent[] = [];
  const task = createNetDoctorTask({
    target: input.request.target,
    symptom: input.request.symptom,
    source: "net-doctor-desktop",
  });

  eventEmitter.subscribe((event) => {
    hostEvents.push(mapRuntimeEventToHostEvent({
      sessionId,
      runtimeEvent: event,
    }));
    const update = mapRuntimeEventToNetDoctorProgress(event);
    if (update) {
      progress.push(update);
    }
  });

  const runtime = createNetDoctorAgentRuntime({
    provider: input.provider ?? createDesktopDemoProvider(),
    storage,
    eventEmitter,
    permissionMode: input.request.permissionMode ?? "trusted",
    permissionService: input.request.permissionMode === "ask"
      ? createHostPermissionService({
        sessionId,
        bridge: async () => ({
          status: "granted",
          reason: "Granted by NetDoctor desktop host bridge.",
        }),
        eventSink: (event) => {
          hostEvents.push(event);
        },
        metadata: {
          host: "net-doctor-desktop",
        },
      })
      : undefined,
    workspaceResolver: createHostWorkspaceResolver({
      workspace: {
        id: "net-doctor-desktop-workspace",
        name: "NetDoctor Desktop workspace",
        rootRef: null,
        trustState: "unknown",
        source: "net-doctor-desktop",
        policyRefs: [],
        metadata: {},
      },
    }),
    identityProvider: createHostIdentityProvider({
      source: "net-doctor-desktop",
    }),
    metadata: {
      executionAccess: input.request.executionAccess ?? "workspace",
    },
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
  const hostResult = await hostAdapter.run({
    sessionId,
    task,
    runtimeOptions: {
      limits: defaultRuntimeLimits,
      permissionMode: input.request.permissionMode ?? "trusted",
      metadata: {
        product: "net-doctor",
        host: "net-doctor-desktop",
        executionAccess: input.request.executionAccess ?? "workspace",
      },
    },
    metadata: {
      host: "net-doctor-desktop",
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

  return {
    status: result.status,
    output: result.output,
    conclusion: viewModel.conclusion,
    evidenceRefs: result.evidenceRefs,
    hostResult,
    hostEvents,
    errors: result.errors.map((error) => ({
      code: error.code,
      message: error.message,
    })),
    progress,
  };
}

function taskSafeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
}
