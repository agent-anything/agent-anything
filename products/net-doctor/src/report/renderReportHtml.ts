import type { NetDoctorReportViewModel } from "./NetDoctorReportViewModel.js";
import { reportStyles } from "./reportStyles.js";

export function renderReportHtml(model: NetDoctorReportViewModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NetDoctor Report</title>
  <style>${reportStyles}</style>
</head>
<body>
  <main>
    <h1>NetDoctor Report</h1>
    <p><span class="status status-${escapeHtml(model.status)}">${escapeHtml(model.status)}</span></p>

    <section>
      <h2>Diagnosis</h2>
      <dl>
        <dt>Target</dt>
        <dd><code>${escapeHtml(model.target)}</code></dd>
        <dt>Symptom</dt>
        <dd>${escapeHtml(model.symptom || "(none)")}</dd>
        <dt>Conclusion</dt>
        <dd>${escapeHtml(model.conclusion)}</dd>
      </dl>
    </section>

    <section>
      <h2>Checks Performed</h2>
      ${renderChecks(model)}
    </section>

    <section>
      <h2>Evidence References</h2>
      ${renderStringList(model.evidenceRefs)}
    </section>

    <section>
      <h2>Stored Artifacts</h2>
      <dl>
        <dt>Report</dt>
        <dd>${model.reportRef === null ? '<span class="muted">(none)</span>' : `<code>${escapeHtml(model.reportRef)}</code>`}</dd>
      </dl>
      ${renderStringList(model.artifactRefs)}
    </section>

    ${renderErrors(model)}

    <section>
      <h2>Suggested Next Steps</h2>
      ${renderStringList(model.nextSteps)}
    </section>
  </main>
</body>
</html>`;
}

function renderChecks(model: NetDoctorReportViewModel): string {
  if (model.checks.length === 0) {
    return '<p class="muted">(none)</p>';
  }

  return `<ul>${model.checks
    .map(
      (check) =>
        `<li>${escapeHtml(check.name)} <span class="muted">(${escapeHtml(check.toolName)})</span></li>`,
    )
    .join("")}</ul>`;
}

function renderErrors(model: NetDoctorReportViewModel): string {
  if (model.errors.length === 0) {
    return "";
  }

  return `<section>
    <h2>Errors</h2>
    <ul>${model.errors
      .map(
        (error) =>
          `<li><code>${escapeHtml(error.code)}</code>: ${escapeHtml(error.message)}</li>`,
      )
      .join("")}</ul>
  </section>`;
}

function renderStringList(items: string[]): string {
  if (items.length === 0) {
    return '<p class="muted">(none)</p>';
  }

  return `<ul>${items.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")}</ul>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
