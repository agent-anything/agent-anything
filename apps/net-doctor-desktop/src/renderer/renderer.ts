import type {
  DesktopDiagnosisRequest,
  DesktopPermissionPreset,
} from "../shared/DesktopDiagnosis.js";

const form = requireElement<HTMLFormElement>("#diagnosis-form");
const targetInput = requireElement<HTMLInputElement>("#target");
const symptomInput = requireElement<HTMLInputElement>("#symptom");
const permissionInput = requireElement<HTMLSelectElement>("#permission");
const runButton = requireElement<HTMLButtonElement>("#run");
const progressList = requireElement<HTMLUListElement>("#progress");
const resultPanel = requireElement<HTMLElement>("#result");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void runDiagnosis();
});

async function runDiagnosis(): Promise<void> {
  runButton.disabled = true;
  progressList.replaceChildren();
  resultPanel.replaceChildren();
  resultPanel.className = "result";

  try {
    const result = await window.netDoctor.diagnose({
      target: targetInput.value,
      symptom: symptomInput.value,
      ...resolvePermissionPreset(permissionInput.value),
    });

    for (const update of result.progress) {
      const item = document.createElement("li");
      item.textContent = `${update.phase}: ${update.message}`;
      progressList.append(item);
    }

    const title = document.createElement("h2");
    title.textContent = `Result: ${result.status}`;
    const conclusion = document.createElement("p");
    conclusion.textContent = result.conclusion;
    const report = document.createElement("p");
    report.textContent = `Output: ${formatOutput(result.output)}`;
    resultPanel.classList.add(result.status === "succeeded" ? "success" : "failed");
    resultPanel.append(title, conclusion, report);

    if (result.errors.length > 0) {
      const errors = document.createElement("ul");
      for (const error of result.errors) {
        const item = document.createElement("li");
        item.textContent = `${error.code}: ${error.message}`;
        errors.append(item);
      }
      resultPanel.append(errors);
    }
  } catch (error) {
    resultPanel.classList.add("failed");
    resultPanel.textContent = error instanceof Error
      ? error.message
      : "NetDoctor desktop diagnosis failed.";
  } finally {
    runButton.disabled = false;
  }
}

function formatOutput(output: unknown): string {
  return output === null ? "(none)" : JSON.stringify(output);
}

function resolvePermissionPreset(
  value: string,
): Pick<DesktopDiagnosisRequest, "permissionMode" | "executionAccess"> {
  const preset = value as DesktopPermissionPreset;

  if (preset === "ask-for-approval") {
    return {
      permissionMode: "ask",
      executionAccess: "workspace",
    };
  }

  if (preset === "full-access") {
    return {
      permissionMode: "trusted",
      executionAccess: "full",
    };
  }

  return {
    permissionMode: "trusted",
    executionAccess: "workspace",
  };
}

function requireElement<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);

  if (!element) {
    throw new Error(`Missing required element '${selector}'.`);
  }

  return element;
}
