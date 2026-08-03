export type HelarcTaskTemplateCategory =
  | "inspect"
  | "edit"
  | "test"
  | "refactor";

export interface CreateHelarcTaskTemplateInput {
  id: string;
  title: string;
  description: string;
  promptText: string;
  category: HelarcTaskTemplateCategory;
  defaultConstraints?: string[];
}

export interface HelarcTaskTemplate {
  id: string;
  title: string;
  description: string;
  promptText: string;
  category: HelarcTaskTemplateCategory;
  defaultConstraints: string[];
}

export type HelarcTaskTemplateErrorCode =
  | "task_template_id_required"
  | "task_template_title_required"
  | "task_template_description_required"
  | "task_template_prompt_required"
  | "task_template_category_invalid"
  | "task_template_not_found";

export interface HelarcTaskTemplateError {
  code: HelarcTaskTemplateErrorCode;
  message: string;
}

export type CreateHelarcTaskTemplateResult =
  | { ok: true; template: HelarcTaskTemplate }
  | { ok: false; error: HelarcTaskTemplateError };

export type SelectHelarcTaskTemplateResult =
  | { ok: true; template: HelarcTaskTemplate; taskText: string }
  | { ok: false; error: HelarcTaskTemplateError };

export function createHelarcTaskTemplate(
  input: CreateHelarcTaskTemplateInput,
): CreateHelarcTaskTemplateResult {
  const id = input.id.trim();
  if (id.length === 0) {
    return reject("task_template_id_required", "Task template id is required.");
  }

  const title = input.title.trim();
  if (title.length === 0) {
    return reject("task_template_title_required", "Task template title is required.");
  }

  const description = input.description.trim();
  if (description.length === 0) {
    return reject("task_template_description_required", "Task template description is required.");
  }

  const promptText = input.promptText.trim();
  if (promptText.length === 0) {
    return reject("task_template_prompt_required", "Task template prompt text is required.");
  }

  if (!isCategory(input.category)) {
    return reject("task_template_category_invalid", "Task template category is invalid.");
  }

  return {
    ok: true,
    template: {
      id,
      title,
      description,
      promptText,
      category: input.category,
      defaultConstraints: normalizeConstraints(input.defaultConstraints ?? []),
    },
  };
}

export function selectHelarcTaskTemplate(
  templates: readonly HelarcTaskTemplate[],
  templateId: string,
): SelectHelarcTaskTemplateResult {
  const id = templateId.trim();
  const template = templates.find((item) => item.id === id);
  if (!template) {
    return reject("task_template_not_found", "Task template was not found.");
  }

  return {
    ok: true,
    template,
    taskText: renderHelarcTaskTemplatePrompt(template),
  };
}

export function renderHelarcTaskTemplatePrompt(template: HelarcTaskTemplate): string {
  if (template.defaultConstraints.length === 0) {
    return template.promptText;
  }

  return `${template.promptText}\n\nConstraints:\n${template.defaultConstraints.map((item) => `- ${item}`).join("\n")}`;
}

export function createBuiltInHelarcTaskTemplates(): HelarcTaskTemplate[] {
  return [
    requiredTemplate({
      id: "inspect-code",
      title: "Inspect code",
      description: "Read relevant files and summarize what should change.",
      category: "inspect",
      promptText: "Inspect the relevant code for the requested area and summarize the implementation approach before making changes.",
      defaultConstraints: [
        "Do not edit files unless a concrete change is required.",
        "Prefer focused findings over broad refactors.",
      ],
    }),
    requiredTemplate({
      id: "implement-change",
      title: "Implement change",
      description: "Make a focused code change and keep the diff small.",
      category: "edit",
      promptText: "Implement the requested change in the selected workspace.",
      defaultConstraints: [
        "Keep edits scoped to the requested behavior.",
        "Update or add tests when the change affects behavior.",
      ],
    }),
    requiredTemplate({
      id: "fix-failing-test",
      title: "Fix failing test",
      description: "Investigate a failing test and apply the smallest correct fix.",
      category: "test",
      promptText: "Investigate the failing test, identify the root cause, and apply the smallest correct fix.",
      defaultConstraints: [
        "Do not weaken assertions just to make the test pass.",
        "Run the focused test after the fix.",
      ],
    }),
    requiredTemplate({
      id: "refactor-module",
      title: "Refactor module",
      description: "Improve structure without changing behavior.",
      category: "refactor",
      promptText: "Refactor the requested module while preserving existing behavior.",
      defaultConstraints: [
        "Avoid broad unrelated cleanup.",
        "Keep public contracts stable unless the task explicitly asks to change them.",
      ],
    }),
  ];
}

function normalizeConstraints(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function isCategory(value: unknown): value is HelarcTaskTemplateCategory {
  return value === "inspect" ||
    value === "edit" ||
    value === "test" ||
    value === "refactor";
}

function requiredTemplate(input: CreateHelarcTaskTemplateInput): HelarcTaskTemplate {
  const result = createHelarcTaskTemplate(input);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.template;
}

function reject(
  code: HelarcTaskTemplateErrorCode,
  message: string,
): { ok: false; error: HelarcTaskTemplateError } {
  return { ok: false, error: { code, message } };
}
