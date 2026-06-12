import * as vscode from "vscode";
import {
  createDefaultRuntime,
  type Evidence,
  ToolRegistry,
  type RuntimeResult,
} from "@agent-anything/platform";
import { NetDoctorEvidenceBuilder } from "./evidence/index.js";
import { createNetDoctorTask } from "./input/index.js";
import {
  openDiagnosisPanel,
  type NetDoctorDiagnosisResult,
} from "./report/index.js";
import { LocalNetDoctorStorage } from "./storage/index.js";
import { registerNetDoctorTools } from "./tools/index.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("NetDoctor");

  const diagnoseCommand = vscode.commands.registerCommand(
    "netDoctor.diagnoseTarget",
    () => {
      openDiagnosisPanel({
        async runDiagnosis(target, symptom) {
          output.show(true);
          output.clear();
          output.appendLine("NetDoctor diagnosis started.");
          output.appendLine(`Target: ${target}`);
          output.appendLine(`Symptom: ${symptom}`);
          output.appendLine("");

          return vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "NetDoctor is diagnosing target...",
              cancellable: false,
            },
            async () => runDiagnosis(target, symptom, context.globalStorageUri.fsPath),
          );
        },
        async onResult(result) {
          writeRuntimeResult(output, result);
          await vscode.window.showInformationMessage(
            `NetDoctor diagnosis ${result.result.status}.`,
          );
        },
        async onError(error) {
          const message = error instanceof Error ? error.message : "Diagnosis failed.";
          output.appendLine(`Error: ${message}`);
          await vscode.window.showErrorMessage(`NetDoctor failed: ${message}`);
        },
      });
    },
  );

  context.subscriptions.push(output, diagnoseCommand);
}

export function deactivate(): void {
  // VS Code calls this when the extension is deactivated.
}

async function runDiagnosis(
  target: string,
  symptom: string,
  storageRoot: string,
): Promise<{
  taskInput: NetDoctorDiagnosisResult["taskInput"];
  result: RuntimeResult;
  evidence: Evidence[];
}> {
  const task = createNetDoctorTask({
    target,
    symptom,
    source: "vscode-extension",
  });
  const toolRegistry = new ToolRegistry();
  registerNetDoctorTools(toolRegistry);
  const storage = new LocalNetDoctorStorage(storageRoot, task.id);
  await storage.storeTask(task);

  const runtime = createDefaultRuntime({
    toolRegistry,
    permissionMode: "trusted",
    storage,
    evidenceBuilder: new NetDoctorEvidenceBuilder(),
    metadata: {
      source: "vscode-extension",
      product: "net-doctor",
    },
  });
  const result = await runtime.run(task);
  await storage.storeRuntimeResult(result);

  return {
    taskInput: task.input,
    result,
    evidence: result.evidenceRefs
      .map((id) => storage.getEvidence(id))
      .filter((item): item is Evidence => item !== undefined),
  };
}

function writeRuntimeResult(
  output: vscode.OutputChannel,
  result: {
    result: RuntimeResult;
  },
): void {
  output.appendLine(`Status: ${result.result.status}`);
  output.appendLine(`Report: ${result.result.reportRef ?? "(none)"}`);
  output.appendLine(`Evidence: ${result.result.evidenceRefs.join(", ") || "(none)"}`);
  output.appendLine(`Artifacts: ${result.result.artifactRefs.join(", ") || "(none)"}`);

  if (result.result.errors.length > 0) {
    output.appendLine("");
    output.appendLine("Errors:");
    for (const error of result.result.errors) {
      output.appendLine(`- ${error.code}: ${error.message}`);
    }
  }
}
