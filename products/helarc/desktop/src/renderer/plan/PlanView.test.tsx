import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HelarcPresentationValue } from "../../shared/HelarcWorkbench.js";
import { ConversationPlan, PlanView } from "./PlanView.js";

const plan: HelarcPresentationValue = {
  id: "plan-1",
  version: 1,
  status: "active",
  steps: [
    { step: "Inspect the existing files", status: "completed" },
    { step: "Implement the change", status: "in_progress" },
    { step: "Check the result", status: "pending" },
  ],
};

describe("Plan content", () => {
  it.each([ConversationPlan, PlanView])("renders recorded step text alongside statuses", (View) => {
    const html = renderToStaticMarkup(<View value={plan} />);
    expect(html).toContain("Inspect the existing files");
    expect(html).toContain("Implement the change");
    expect(html).toContain("Check the result");
    expect(html).toContain("<small>completed</small>");
    expect(html).toContain("<small>in progress</small>");
    expect(html).toContain("<small>pending</small>");
  });

  it("includes the current step text in the collapsed conversation summary", () => {
    const html = renderToStaticMarkup(<ConversationPlan value={plan} />);
    const summary = html.slice(html.indexOf('class="wb-plan-summary"'), html.indexOf('class="wb-plan-steps"'));
    expect(summary).toContain("Implement the change");
    expect(summary).toContain("1/3");
    expect(html).toContain('aria-label="Expand Plan"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="wb-plan-steps" hidden=""');
  });

  it.each([ConversationPlan, PlanView])("does not invent a Plan when none is recorded", (View) => {
    expect(renderToStaticMarkup(<View value={null} />)).toBe("");
    expect(renderToStaticMarkup(<View value={{ steps: [] }} />)).toBe("");
  });
});
