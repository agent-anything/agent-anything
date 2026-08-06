import { describe, expect, it } from "vitest";
import {
  createBuiltInHelarcTaskTemplates,
  createHelarcTaskTemplate,
  selectHelarcTaskTemplate,
} from "./HelarcTaskTemplate.js";

describe("HelarcTaskTemplate", () => {
  it("creates task templates with normalized fields", () => {
    const result = createHelarcTaskTemplate({
      id: " inspect ",
      title: " Inspect ",
      description: " Read files ",
      promptText: " Inspect the code ",
      category: "inspect",
      defaultConstraints: [" Keep it focused ", ""],
    });

    expect(result).toEqual({
      ok: true,
      template: {
        id: "inspect",
        title: "Inspect",
        description: "Read files",
        promptText: "Inspect the code",
        category: "inspect",
        defaultConstraints: ["Keep it focused"],
      },
    });
  });

  it("rejects invalid templates", () => {
    expect(createHelarcTaskTemplate({
      id: "",
      title: "Title",
      description: "Description",
      promptText: "Prompt",
      category: "inspect",
    })).toMatchObject({
      ok: false,
      error: { code: "task_template_id_required" },
    });

    expect(createHelarcTaskTemplate({
      id: "template",
      title: "Title",
      description: "Description",
      promptText: "Prompt",
      category: "unknown" as "inspect",
    })).toMatchObject({
      ok: false,
      error: { code: "task_template_category_invalid" },
    });
  });

  it("selects templates and renders editable task text", () => {
    const templates = createBuiltInHelarcTaskTemplates();
    const result = selectHelarcTaskTemplate(templates, "implement-change");

    expect(result).toMatchObject({
      ok: true,
      template: { id: "implement-change" },
    });
    expect(result.ok ? result.taskText : "").toContain("Implement the requested change");
    expect(result.ok ? result.taskText : "").toContain("Constraints:");
  });

  it("rejects missing template selection", () => {
    expect(selectHelarcTaskTemplate(createBuiltInHelarcTaskTemplates(), "missing")).toMatchObject({
      ok: false,
      error: { code: "task_template_not_found" },
    });
  });
});
