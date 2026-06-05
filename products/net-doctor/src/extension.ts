import * as vscode from "vscode";
import {
  createDefaultRuntime,
  type Evidence,
  ToolRegistry,
  type RuntimeResult,
} from "@agent-anything/platform";
import { NetDoctorEvidenceBuilder } from "./evidence/index.js";
import { createNetDoctorTask } from "./input/index.js";
import { openReportPanel } from "./report/index.js";
import { LocalNetDoctorStorage } from "./storage/index.js";
import { registerNetDoctorTools } from "./tools/index.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("NetDoctor");

  const diagnoseCommand = vscode.commands.registerCommand(
    "netDoctor.diagnoseTarget",
    async () => {
      const target = await vscode.window.showInputBox({
        title: "NetDoctor",
        prompt: "Enter a domain, URL, host, or host:port.",
        placeHolder: "example.com",
        ignoreFocusOut: true,
        validateInput(value) {
          return value.trim().length === 0 ? "Target is required." : null;
        },
      });

      if (target === undefined) {
        return;
      }

      const symptom = await vscode.window.showInputBox({
        title: "NetDoctor",
        prompt: "Describe the symptom.",
        placeHolder: "Cannot connect",
        ignoreFocusOut: true,
      });

      if (symptom === undefined) {
        return;
      }

      output.show(true);
      output.clear();
      output.appendLine("NetDoctor diagnosis started.");
      output.appendLine(`Target: ${target}`);
      output.appendLine(`Symptom: ${symptom}`);
      output.appendLine("");

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "NetDoctor is diagnosing target...",
            cancellable: false,
          },
          async () => runDiagnosis(target, symptom, context.globalStorageUri.fsPath),
        );

        writeRuntimeResult(output, result);
        openReportPanel({
          taskInput: result.task.input,
          result: result.result,
          evidence: result.evidence,
        });
        await vscode.window.showInformationMessage(
          `NetDoctor diagnosis ${result.result.status}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Diagnosis failed.";
        output.appendLine(`Error: ${message}`);
        await vscode.window.showErrorMessage(`NetDoctor failed: ${message}`);
      }
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
  task: ReturnType<typeof createNetDoctorTask>;
  result: RuntimeResult;
  evidence: Evidence[];
}> {
  const task = createNetDoctorTask({
    target,
    symptom,
  });
  const toolRegistry = new ToolRegistry();
  registerNetDoctorTools(toolRegistry);
  const storage = new LocalNetDoctorStorage(storageRoot, task.id);
  await storage.storeTask(task);

  const runtime = createDefaultRuntime({
    toolRegistry,
    permissionMode: "allowAll",
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
    task,
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
