import * as vscode from "vscode";
import type { Evidence, RuntimeResult } from "@agent-anything/platform";
import type { NetDoctorInput } from "../input/index.js";
import { createNetDoctorReportViewModel } from "./NetDoctorReportViewModel.js";
import { renderReportHtml } from "./renderReportHtml.js";

export function openReportPanel(input: {
  taskInput: NetDoctorInput & {
    toolCalls: Array<{
      toolName: string;
    }>;
  };
  result: RuntimeResult;
  evidence?: Evidence[];
}): void {
  const panel = vscode.window.createWebviewPanel(
    "netDoctor.report",
    "NetDoctor Report",
    vscode.ViewColumn.One,
    {
      enableScripts: false,
    },
  );

  panel.webview.html = renderReportHtml(
    createNetDoctorReportViewModel({
      taskInput: input.taskInput,
      result: input.result,
      evidence: input.evidence,
    }),
  );
}
