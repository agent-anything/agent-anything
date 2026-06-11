import {
  InMemoryStorage,
  RuntimeEventEmitter,
  type Evidence,
  type Provider,
  type RuntimeResult,
} from "@agent-anything/platform";
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
  reportRef: string | null;
  evidenceRefs: string[];
}

export async function runNetDoctorCli(
  input: RunNetDoctorCliInput,
): Promise<RunNetDoctorCliResult> {
  const write = input.write ?? console.log;
  const eventEmitter = new RuntimeEventEmitter();
  const storage = new InMemoryStorage();
  const provider = input.provider ?? createDemoNetDoctorProvider();
  const task = createNetDoctorTask({
    target: input.args.target,
    symptom: input.args.symptom,
    source: "net-doctor-cli",
  });

  eventEmitter.subscribe((event) => {
    const update = mapRuntimeEventToNetDoctorProgress(event);
    if (update) {
      write(`[${update.phase}] ${update.message}`);
    }
  });

  const runtime = createNetDoctorAgentRuntime({
    provider,
    storage,
    eventEmitter,
  });

  write(`NetDoctor diagnosis: ${input.args.target}`);

  const result = await runtime.run(task);
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
  write(`Report: ${result.reportRef ?? "(none)"}`);

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      write(`Error: ${error.code}: ${error.message}`);
    }
  }

  return {
    status: result.status,
    exitCode: result.status === "succeeded" ? 0 : 1,
    reportRef: result.reportRef,
    evidenceRefs: result.evidenceRefs,
  };
}
