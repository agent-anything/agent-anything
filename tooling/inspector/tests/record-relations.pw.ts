import { expect, test, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { inspectionContentId } from "@agent-anything/inspection/adapters";
import type { InspectionLink, InspectionSubjectRef } from "@agent-anything/inspection/records";
import { startInspectorServer } from "../dist/server/InspectorServer.js";
import { createTestRecording } from "./recording.js";

async function relationsFixture() {
  const recording = await createTestRecording();
  const { recorder } = recording;
  const agent = recorder.ref("agent-core", "definition", "agent-definition", null, "1");
  const newerAgent = { ...agent, revision: "2" };
  const request = recorder.ref("model-interaction", "request", "child-request", "child-investigation");
  const missing = recorder.ref("agent-core", "definition", agent.id, null, "missing-revision");
  const link = (from: InspectionSubjectRef, to: InspectionSubjectRef, kind: InspectionLink["kind"], condition: InspectionLink["condition"] = null) => ({ from, to, kind, condition, operation: null, sourceLocation: null, targetLocation: null });
  for (const [subject, name] of [[agent, "Agent v1"], [newerAgent, "Agent v2"]] as const) {
    recorder.offer({ id: name, subject, occurredAt: null, payload: { kind: "definition", definitionKind: "agent", name, revision: subject.revision!, enabled: true } });
  }
  recorder.offer({ id: "child-request-record", subject: request, occurredAt: null,
    payload: { kind: "request", purpose: "controller", providerId: "test", model: "test-model", compositionId: "composition", messageCount: 1, toolCount: 0 },
    contents: [{ name: "Child semantic request", stage: "semantic", class: "provider", mediaType: "application/json", value: { messages: [{ role: "user", content: "exact historical request" }] } }],
  });
  recorder.offer({ id: "agent-binding-event", subject: agent, occurredAt: null,
    payload: { kind: "event", name: "request_binding.agent", code: null, sequence: null },
    links: [link(agent, request, "binding"), link(request, agent, "trigger"), link(missing, request, "prerequisite", "succeeded"),
      { ...link(agent, request, "includes"), operation: "recorded inclusion", targetLocation: { contentId: inspectionContentId("child-request-record"), partId: null, jsonPointer: "/messages/0", stage: "semantic" } },
      link(agent, agent, "binding")],
  });
  for (let i = 0; i < 22; i++) recorder.offer({ id: `request-fact-${i}`, subject: request, occurredAt: null, payload: { kind: "event", name: `Request fact ${i}`, code: null, sequence: null } });
  await recorder.flush();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  const url = new URL(server.launchUrl);
  url.searchParams.set("source", recording.sourceId); url.searchParams.set("dataset", recording.datasetId);
  url.searchParams.set("area", "Definitions"); url.searchParams.set("run", "root-run");
  url.searchParams.set("subject", JSON.stringify(agent)); url.searchParams.set("record", "agent-binding-event");
  return { ...recording, server, url, agent, request };
}

async function openBindingObject(page: Page, binding: Locator, endpoint: number) {
  await binding.getByRole("button", { name: "Inspect binding relation", exact: true }).click();
  await page.getByRole("dialog", { name: "Recorded relation", exact: true }).locator(".relation-endpoint").nth(endpoint)
    .getByRole("button", { name: "Open object", exact: true }).click();
}

test("records expose typed relations and open exact object content without changing investigation scope", async ({ page }, testInfo) => {
  const fixture = await relationsFixture();
  const queries: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/api/inspection/query")) queries.push(request.postDataJSON()); });
  try {
    await page.goto(fixture.url.toString());
    const detail = page.locator(".detail-pane");
    await expect(detail.locator(".record-relation")).toHaveCount(5);
    const original = new URL(page.url());
    const binding = detail.locator(".record-relation").first();
    await expect(detail.locator(".record-relations")).not.toContainText("child-request");
    await expect(detail.locator(".record-relations")).not.toContainText("agent-definition");
    await binding.getByRole("button", { name: "Inspect binding relation", exact: true }).click();
    const relation = page.getByRole("dialog", { name: "Recorded relation", exact: true });
    await expect(relation.getByRole("heading", { name: "Target", exact: true })).toBeVisible();
    const before = queries.length;
    await relation.locator(".relation-endpoint").nth(1).getByRole("button", { name: "Open object", exact: true }).click();
    const object = page.getByRole("dialog", { name: "Related object", exact: true });
    await expect(object).toContainText("Run: child-investigation");
    await expect(object.locator(".related-object-facts .ant-table-row")).toHaveCount(20);
    expect(queries.slice(before).every(query => query.kind === "list_records" && query.limit === 20 && !query.runId)).toBe(true);
    await object.getByRole("button", { name: "Child semantic request semantic / present", exact: true }).click();
    const content = page.getByRole("dialog", { name: "Child semantic request", exact: true });
    await expect(content.locator(".view-lines")).toContainText("exact historical request");
    await content.getByRole("button", { name: "Close", exact: true }).click();
    await object.getByRole("button", { name: "Load more object records", exact: true }).click();
    await expect(object.locator(".related-object-facts .ant-table-row")).toHaveCount(23);
    await expect(object.getByRole("button", { name: "Load more object records", exact: true })).toHaveCount(0);
    await object.locator(".ant-drawer-body").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("related-request-desktop.png"), fullPage: true, animations: "disabled" });
    for (const key of ["source", "dataset", "watermark", "area", "run", "record", "subject"]) expect(new URL(page.url()).searchParams.get(key)).toBe(original.searchParams.get(key));
    await object.getByRole("button", { name: "Close", exact: true }).click();
    await binding.getByRole("button", { name: "Inspect binding relation", exact: true }).click();
    await expect(relation).toContainText("Revision: 1");
    await relation.locator(".relation-endpoint").first().getByRole("button", { name: "Open object", exact: true }).click();
    await expect(object).toContainText("Agent v1 / 1");
    await expect(object).not.toContainText("Agent v2");
    await page.goBack();
    await expect(relation).toBeVisible();
    await relation.getByRole("button", { name: "agent-binding-event", exact: true }).click();
    const fact = page.getByRole("dialog", { name: "Recorded fact", exact: true });
    await expect(fact.locator(".record-relation")).toHaveCount(5);
    await fact.getByRole("button", { name: "Inspect includes relation", exact: true }).click();
    await expect(relation).toContainText("/messages/0");
    await relation.getByRole("button", { name: "Open recorded content", exact: true }).click();
    await expect(content.locator(".coverage-note")).toContainText("JSON pointer: /messages/0");
    await expect(content.locator(".view-lines")).toContainText("exact historical request");
    await content.getByRole("button", { name: "Close", exact: true }).click();
    await relation.getByRole("button", { name: "Close", exact: true }).click();
    await detail.getByRole("button", { name: "Inspect prerequisite relation", exact: true }).click();
    await expect(relation).toContainText("succeeded");
    await relation.locator(".relation-endpoint").first().getByRole("button", { name: "Open object", exact: true }).click();
    await expect(object).toContainText("No records for this exact object at this snapshot.");
    await expect(object).toContainText("missing-revision");
    await object.getByRole("button", { name: "Close", exact: true }).click();
    await expect(object).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(binding.getByRole("button", { name: "Inspect binding relation", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("record-relations-narrow.png"), fullPage: true, animations: "disabled" });
    await openBindingObject(page, binding, 1);
    await expect(object).toContainText("Child semantic request");
    await page.screenshot({ path: testInfo.outputPath("related-request-narrow.png"), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await fixture.server.close(); await fixture.close(); }
});

test("closing or changing contextual targets rejects late reads and history uses the target Run", async ({ page }) => {
  const fixture = await relationsFixture();
  try {
    await page.goto(fixture.url.toString());
    const binding = page.locator(".detail-pane .record-relation").first();
    await expect(binding).toBeVisible();
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/inspection/query", async route => {
      const query = route.request().postDataJSON();
      if (query.kind === "list_records" && query.subject?.id === "child-request") await delayed;
      await route.continue().catch(() => {});
    });
    const requested = page.waitForRequest(request => request.url().includes("/api/inspection/query") && request.postDataJSON()?.subject?.id === "child-request");
    await openBindingObject(page, binding, 1);
    await requested;
    const object = page.getByRole("dialog", { name: "Related object", exact: true });
    await object.getByRole("button", { name: "Close", exact: true }).click();
    await openBindingObject(page, binding, 0);
    await expect(object).toContainText("Agent v1 / 1");
    release();
    await expect(object).not.toContainText("Child semantic request");
    await object.getByRole("button", { name: "Close", exact: true }).click();
    await openBindingObject(page, binding, 1);
    await expect(object).toContainText("Child semantic request");
    await object.getByRole("button", { name: "Object history", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("run")).toBe("child-investigation");
    await expect(page.locator(".records-table")).toContainText("Request fact 21");
  } finally { await fixture.server.close(); await fixture.close(); }
});
