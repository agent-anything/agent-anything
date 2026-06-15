import { InMemoryStorage } from "@agent-anything/storage";
import { RuntimeEventEmitter, type RuntimeResult } from "@agent-anything/agent-core";
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
    permissionMode: input.args.permissionMode,
  });

  write(`NetDoctor diagnosis: ${input.args.target}`);

  const result: RuntimeResult = await runtime.run(task);
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
  };
}

function formatOutput(output: unknown): string {
  return output === null ? "(none)" : JSON.stringify(output);
}
