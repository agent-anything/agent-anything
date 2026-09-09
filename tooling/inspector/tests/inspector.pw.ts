import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInspectorServer } from "../dist/server/InspectorServer.js";
import { createTestRecording } from "./recording.js";

test("independent recorded-data investigation with local workers and manual refresh", async ({ page }, testInfo) => {
  const recording = await createTestRecording();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  let queries = 0; page.on("request", (request) => { if (request.url().includes("/api/inspection/query")) queries++; });
  try {
    await page.goto(server.launchUrl);
    await page.getByRole("combobox", { name: "Source", exact: true }).click();
    await page.getByText("Component qualification", { exact: true }).click();
    await page.getByRole("combobox", { name: "Recording", exact: true }).click();
    await page.locator(".ant-select-item-option").filter({ hasText: "open" }).click();
    await expect(page.locator(".object-row").filter({ hasText: "root-run" })).toBeVisible();
    await page.getByRole("tab", { name: "Hierarchy", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await page.getByRole("button", { name: "Auto layout", exact: true }).click();
    await expect(page.locator('.graph-surface[data-layout="ready"]')).toBeVisible();
    await expect(page.getByText("Layout timed out")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hierarchy-desktop.png"), fullPage: true });
    await page.locator(".object-row").filter({ hasText: "root-run" }).click();
    await page.getByRole("tab", { name: "Lifecycle", exact: true }).click();
    await expect(page.locator(".lifecycle-map .react-flow__node")).toHaveCount(4);
    await expect(page.getByText("pending_opened", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.locator(".vis-timeline")).toBeVisible();
    await page.getByRole("tab", { name: "Records", exact: true }).click();
    await expect(page.locator('.investigation[data-view="list_records"]')).toBeVisible();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
    await expect(page.locator(".selection-heading .ant-spin")).toHaveCount(0);
    const idle = queries; await page.waitForTimeout(1200); expect(queries).toBe(idle);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("inspector-narrow.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await server.close(); await recording.close(); }
});

test("nested groups, evidence edges, exact record history and watermark refresh", async ({ page }, testInfo) => {
  const recording = await createTestRecording(true);
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(server.launchUrl);
    await page.getByRole("combobox", { name: "Source", exact: true }).click();
    await page.getByText("Component qualification", { exact: true }).click();
    await page.getByRole("combobox", { name: "Recording", exact: true }).click();
    await page.locator(".ant-select-item-option").filter({ hasText: "open" }).click();
    await page.getByRole("tab", { name: "Hierarchy", exact: true }).click();
    await expect(page.locator('.graph-surface[data-layout="ready"]')).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(6);
    await page.getByRole("button", { name: "Collapse child-investigation", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await page.getByRole("button", { name: "Expand child-investigation", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(6);
    await page.getByRole("tab", { name: "Data Flow", exact: true }).click();
    await expect(page.locator('.investigation[data-view="get_data_flow"]')).toBeVisible();
    await expect(page.locator('.graph-surface[data-layout="ready"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("data-flow-desktop.png"), fullPage: true });
    const paths = await page.locator(".react-flow__edge-path").evaluateAll((items) => items.map((item) => item.getAttribute("d")));
    expect(new Set(paths).size).toBe(paths.length);
    const graphNode = page.locator(".react-flow__node").filter({ hasText: "parent-request" }).first();
    const before = await graphNode.boundingBox();
    await page.mouse.move(before!.x + 40, before!.y + 35); await page.mouse.down(); await page.mouse.move(before!.x + 85, before!.y + 70, { steps: 5 }); await page.mouse.up();
    await page.getByRole("button", { name: "Auto layout", exact: true }).click();
    await expect(page.locator('.graph-surface[data-layout="ready"]')).toBeVisible();
    const clear = page.getByRole("button", { name: "Clear object selection", exact: true });
    if (await clear.count()) await clear.click();
    await page.getByRole("tab", { name: "Records", exact: true }).click();
    await expect(page.locator('.investigation[data-view="list_records"]')).toBeVisible();
    const transition = page.locator(".records-table .ant-table-row").filter({ hasText: "running -> waiting" });
    await transition.click();
    await expect(page.locator(".detail-pane")).toContainText("running -> waiting");
    const recordUrl = page.url();
    await page.getByRole("tab", { name: "Lifecycle", exact: true }).click();
    await expect(page.locator('.investigation[data-view="get_lifecycle"]')).toBeVisible();
    await expect(page.locator(".detail-pane")).toContainText("running -> waiting");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(recordUrl);
    const oldWatermark = new URL(page.url()).searchParams.get("watermark");
    recording.recorder.offer({ subject: recording.recorder.ref("runtime", "run", "root-run", "root-run"), occurredAt: null, payload: { kind: "snapshot", status: "succeeded", revision: 4, agentId: "qualification-agent", parentRunId: null, taskId: "component-proof" } });
    await recording.recorder.flush();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("watermark")).not.toBe(oldWatermark);
    await expect(page.locator(".detail-pane")).toContainText("running -> waiting");
    expect(errors).toEqual([]);
  } finally { await server.close(); await recording.close(); }
});

test("bounded larger recording keeps graph and scheduling views navigable", async ({ page }, testInfo) => {
  const recording = await createTestRecording();
  const root = recording.recorder.ref("runtime", "run", "root-run", "root-run");
  for (let i = 0; i < 60; i++) {
    const subject = recording.recorder.ref("runtime", "call", `bounded-call-${i}`, root.id);
    recording.recorder.offer({ subject, occurredAt: null, payload: { kind: "scheduling", position: i, disposition: "dispatched", rule: "serial", reason: null, groupId: "bounded-decision" }, links: [{ from: root, to: subject, kind: "contains", condition: null, operation: null, sourceLocation: null, targetLocation: null }] });
    for (const phase of ["started", "settled"] as const) expect(recording.recorder.offer({ subject, occurredAt: new Date(Date.UTC(2026, 8, 9, 0, 1, i) + (phase === "settled" ? 500 : 0)).toISOString(), payload: { kind: "interval", phase, activity: "operation", status: phase === "settled" ? "succeeded" : null, clock: "test-process" } })).toBe(true);
  }
  await recording.recorder.flush();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    const url = new URL(server.launchUrl); url.searchParams.set("source", recording.sourceId); url.searchParams.set("dataset", recording.datasetId); url.searchParams.set("view", "Hierarchy");
    await page.goto(url.toString());
    await expect(page.locator('.graph-surface[data-layout="ready"]')).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(64);
    await page.screenshot({ path: testInfo.outputPath("bounded-hierarchy.png"), fullPage: true });
    await page.locator(".object-row").filter({ hasText: "root-run" }).click();
    await page.getByRole("tab", { name: "Scheduling", exact: true }).click();
    await expect(page.locator(".records-table")).toContainText("bounded-call-0");
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.locator(".vis-labelset .vis-label")).toHaveCount(61);
    expect(errors).toEqual([]);
  } finally { await server.close(); await recording.close(); }
});
