import {
  InMemoryStorage,
  RuntimeEventEmitter,
  type Evidence,
  type Provider,
} from "@agent-anything/platform";
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
  const task = createNetDoctorTask({
    target: input.request.target,
    symptom: input.request.symptom,
    source: "net-doctor-desktop",
  });

  eventEmitter.subscribe((event) => {
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
    metadata: {
      executionAccess: input.request.executionAccess ?? "workspace",
    },
  });
  const result = await runtime.run(task);
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
    reportRef: result.reportRef,
    conclusion: viewModel.conclusion,
    evidenceRefs: result.evidenceRefs,
    errors: result.errors.map((error) => ({
      code: error.code,
      message: error.message,
    })),
    progress,
  };
}
