import * as vscode from "vscode";
import type { Evidence, RuntimeResult } from "@agent-anything/platform";
import type { NetDoctorInput } from "../input/index.js";
import { createNetDoctorReportViewModel } from "./NetDoctorReportViewModel.js";
import { renderReportHtml } from "./renderReportHtml.js";
import { reportStyles } from "./reportStyles.js";

export interface NetDoctorDiagnosisResult {
  taskInput: NetDoctorInput & {
    toolCalls: Array<{
      toolName: string;
    }>;
  };
  result: RuntimeResult;
  evidence: Evidence[];
}

export type RunNetDoctorDiagnosis = (
  target: string,
  symptom: string,
) => Promise<NetDoctorDiagnosisResult>;

export function openDiagnosisPanel(input: {
  runDiagnosis: RunNetDoctorDiagnosis;
  onResult?: (result: NetDoctorDiagnosisResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}): void {
  const panel = vscode.window.createWebviewPanel(
    "netDoctor.diagnosis",
    "NetDoctor Diagnosis",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
    },
  );

  panel.webview.html = renderDiagnosisFormHtml({ webview: panel.webview });

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!isStartDiagnosisMessage(message)) {
      return;
    }

    const target = message.target.trim();
    const symptom = message.symptom.trim();

    if (target.length === 0) {
      panel.webview.html = renderDiagnosisFormHtml({
        webview: panel.webview,
        target: message.target,
        symptom: message.symptom,
        error: "Target is required.",
      });
      return;
    }

    panel.webview.html = renderDiagnosisRunningHtml({
      target,
      symptom,
    });

    try {
      const result = await input.runDiagnosis(target, symptom);
      panel.webview.html = renderReportHtml(
        createNetDoctorReportViewModel({
          taskInput: result.taskInput,
          result: result.result,
          evidence: result.evidence,
        }),
      );
      try {
        await input.onResult?.(result);
      } catch (callbackError) {
        await input.onError?.(callbackError);
      }
    } catch (error) {
      await input.onError?.(error);
      panel.webview.html = renderDiagnosisFormHtml({
        webview: panel.webview,
        target,
        symptom,
        error: error instanceof Error ? error.message : "Diagnosis failed.",
      });
    }
  });
}

function renderDiagnosisFormHtml(input: {
  webview: vscode.Webview;
  target?: string;
  symptom?: string;
  error?: string;
}): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>NetDoctor Diagnosis</title>
  <style>${reportStyles}${diagnosisStyles}</style>
</head>
<body>
  <main>
    <h1>NetDoctor Diagnosis</h1>
    ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
    <form id="diagnosis-form">
      <label>
        <span>Target</span>
        <input id="target" name="target" type="text" value="${escapeHtml(input.target ?? "")}" placeholder="example.com" autofocus />
      </label>
      <label>
        <span>Symptom</span>
        <textarea id="symptom" name="symptom" rows="5" placeholder="Cannot connect">${escapeHtml(input.symptom ?? "")}</textarea>
      </label>
      <button type="submit">Start Diagnosis</button>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById("diagnosis-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      vscode.postMessage({
        type: "startDiagnosis",
        target: document.getElementById("target").value,
        symptom: document.getElementById("symptom").value,
      });
    });
  </script>
</body>
</html>`;
}

function renderDiagnosisRunningHtml(input: {
  target: string;
  symptom: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>NetDoctor Diagnosis</title>
  <style>${reportStyles}${diagnosisStyles}</style>
</head>
<body>
  <main>
    <h1>NetDoctor Diagnosis</h1>
    <p><span class="status">running</span></p>
    <section>
      <h2>Diagnosis</h2>
      <dl>
        <dt>Target</dt>
        <dd><code>${escapeHtml(input.target)}</code></dd>
        <dt>Symptom</dt>
        <dd>${escapeHtml(input.symptom || "(none)")}</dd>
      </dl>
    </section>
    <section>
      <h2>Progress</h2>
      <p>NetDoctor is running Phase1 checks...</p>
    </section>
  </main>
</body>
</html>`;
}

const diagnosisStyles = `
  form {
    border-top: 1px solid var(--vscode-panel-border);
    display: grid;
    gap: 16px;
    margin-top: 18px;
    padding-top: 18px;
  }

  label {
    display: grid;
    gap: 6px;
  }

  label span {
    color: var(--vscode-descriptionForeground);
  }

  input,
  textarea {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    color: var(--vscode-input-foreground);
    font: inherit;
    padding: 8px;
  }

  textarea {
    resize: vertical;
  }

  button {
    justify-self: start;
    background: var(--vscode-button-background);
    border: 0;
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font: inherit;
    padding: 8px 12px;
  }

  button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .error {
    color: var(--vscode-errorForeground);
  }
`;

function isStartDiagnosisMessage(value: unknown): value is {
  type: "startDiagnosis";
  target: string;
  symptom: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "startDiagnosis" &&
    typeof record.target === "string" &&
    typeof record.symptom === "string"
  );
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
