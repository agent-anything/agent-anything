import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInspectorServer } from "../dist/server/InspectorServer.js";
import { createTestRecording } from "./recording.js";

test("object catalog scrolls to its last entry without hiding navigation controls", async ({ page }, testInfo) => {
  const recording = await createTestRecording();
  for (let index = 0; index < 101; index++) {
    const name = `Tool ${String(index).padStart(3, "0")}`;
    recording.recorder.offer({ subject: recording.recorder.ref("tools", "definition", `tool-${index}`, null, "1"), occurredAt: null, payload: { kind: "definition", definitionKind: "tool", name, revision: "1", enabled: true } });
  }
  await recording.recorder.flush();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  try {
    const url = new URL(server.launchUrl);
    url.searchParams.set("source", recording.sourceId);
    url.searchParams.set("dataset", recording.datasetId);
    url.searchParams.set("area", "Definitions");
    await page.goto(url.toString());
    await expect(page.locator(".object-row")).toHaveCount(100);
    await page.locator(".object-row").first().click();
    const list = page.locator(".object-list");
    for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await list.evaluate((element) => { element.scrollTop = 0; });
      const dimensions = await list.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, bottom: element.getBoundingClientRect().bottom }));
      expect(dimensions.height).toBeGreaterThan(0);
      expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
      expect(dimensions.bottom).toBeLessThanOrEqual(viewport.height + 1);
      await list.hover();
      await page.mouse.wheel(0, 100000);
      await expect(page.locator(".object-row").filter({ hasText: "Tool 099" })).toBeInViewport();
      await expect(page.getByRole("textbox", { name: "Search objects", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Clear object selection", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Load more objects", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`catalog-scroll-${viewport.width}.png`), fullPage: true, animations: "disabled" });
    }
    await page.getByRole("button", { name: "Load more objects", exact: true }).click();
    await expect(page.locator(".object-row")).toHaveCount(101);
    await list.hover();
    await page.mouse.wheel(0, 100000);
    await expect(page.locator(".object-row").filter({ hasText: "Tool 100" })).toBeInViewport();
  } finally { await server.close(); await recording.close(); }
});

test("selected definition stays in object navigation with its clear action", async ({ page }, testInfo) => {
  const recording = await createTestRecording();
  recording.recorder.offer({
    subject: recording.recorder.ref("tools", "definition", "read-tool-definition-with-a-long-stable-identity", null, "1"),
    occurredAt: null,
    payload: { kind: "definition", definitionKind: "tool", name: "Read", revision: "1", enabled: true },
    contents: [{ name: "Tool Contract", stage: "registered", class: "definition", mediaType: "application/json", value: {
      name: "Read", description: "Read the contents of a workspace file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    } }],
  });
  await recording.recorder.flush();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  try {
    const url = new URL(server.launchUrl);
    url.searchParams.set("source", recording.sourceId);
    url.searchParams.set("dataset", recording.datasetId);
    url.searchParams.set("area", "Definitions");
    await page.goto(url.toString());
    await page.locator(".object-row").filter({ hasText: "Read" }).click();
    const selection = page.locator(".object-pane").getByRole("group", { name: "Selected object", exact: true });
    await expect(selection).toContainText("Read");
    await expect(page.locator(".investigation").getByRole("group", { name: "Selected object", exact: true })).toHaveCount(0);
    await expect(page.locator(".records-table .ant-table-row")).toHaveCount(1);
    await expect(page.locator(".records-table")).toContainText("Read");
    await page.screenshot({ path: testInfo.outputPath("definition-selection-desktop.png"), fullPage: true });
    const contract = page.locator(".content-row").filter({ hasText: "Tool Contract" });
    await expect(contract.locator(".content-row-name")).toHaveCSS("text-decoration-line", "underline");
    await expect(contract.locator(".content-row-arrow")).toBeVisible();
    await contract.click();
    const drawer = page.getByRole("dialog", { name: "Tool Contract", exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".line-numbers").filter({ hasText: /^2$/ })).toBeVisible();
    await expect(drawer.locator(".view-lines")).toContainText('"inputSchema"');
    await page.screenshot({ path: testInfo.outputPath("tool-contract-formatted.png"), fullPage: true });
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.locator(".vis-timeline")).toBeVisible();
    await expect(selection).toContainText("Read");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(selection.getByRole("button", { name: "Clear object selection", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("definition-selection-narrow.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await selection.getByRole("button", { name: "Clear object selection", exact: true }).click();
    await expect(selection).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("subject")).toBeNull();
  } finally { await server.close(); await recording.close(); }
});

test("uncaptured Agent definition opens its recorded state without an access error", async ({ page }, testInfo) => {
  const recording = await createTestRecording();
  recording.recorder.setPolicy({ revision: "agent-disabled", enabled: true, definition: true, agent: false, provider: false, execution: false });
  recording.recorder.offer({
    subject: recording.recorder.ref("agent-core", "definition", "helarc", null, "1"), occurredAt: null,
    payload: { kind: "definition", definitionKind: "agent", name: "Helarc", revision: "1", enabled: true },
    contents: [{ name: "Agent definition", stage: "registered", class: "agent", mediaType: "application/json", value: { name: "Helarc" } }],
  });
  await recording.recorder.flush();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  try {
    const url = new URL(server.launchUrl);
    url.searchParams.set("source", recording.sourceId);
    url.searchParams.set("dataset", recording.datasetId);
    url.searchParams.set("area", "Definitions");
    await page.goto(url.toString());
    await page.locator(".object-row").filter({ hasText: "Helarc" }).click();
    await page.locator(".content-row").filter({ hasText: "Agent definition" }).click();
    const drawer = page.getByRole("dialog", { name: "Agent definition", exact: true });
    await expect(drawer.getByText("Content was not captured for this record", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Copy loaded range", exact: true })).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "Download retained content", exact: true })).toBeDisabled();
    await expect(page.getByText("inspection_access_denied", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("uncaptured-agent-definition.png"), fullPage: true, animations: "disabled" });
  } finally { await server.close(); await recording.close(); }
});

test("shared content viewer manually formats text as JSON and restores the recorded text", async ({ page }, testInfo) => {
  const recording = await createTestRecording();
  const text = '{"count":9007199254740993,"items":[1,2]}';
  recording.recorder.offer({
    id: "manual-format-record",
    subject: recording.recorder.ref("provider", "provider-attempt", "format-attempt", "root-run"),
    occurredAt: null, payload: { kind: "event", name: "provider.dispatch", sequence: null, code: null },
    contents: [
      { name: "Encoded request body", stage: "encoded_json", class: "provider", mediaType: "text/plain", value: text },
      { name: "Other JSON text", stage: "recorded", class: "provider", mediaType: "text/plain", value: '{"count":2,"items":[3]}' },
      { name: "Non-JSON text", stage: "recorded", class: "provider", mediaType: "text/plain", value: "This is not JSON." },
      { name: "Incomplete JSON", stage: "recorded", class: "provider", mediaType: "text/plain", value: '{"count":' },
    ],
  });
  await recording.recorder.flush();
  const server = await startInspectorServer({ root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url)) });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    const url = new URL(server.launchUrl);
    url.searchParams.set("source", recording.sourceId);
    url.searchParams.set("dataset", recording.datasetId);
    url.searchParams.set("record", "manual-format-record");
    await page.goto(url.toString());
    await page.locator(".content-row").filter({ hasText: "Encoded request body" }).click();
    const drawer = page.getByRole("dialog", { name: "Encoded request body", exact: true });
    await expect(drawer.locator(".view-lines")).toContainText(text);
    await expect(drawer.locator(".line-numbers").filter({ hasText: /^2$/ })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Format JSON", exact: true }).click();
    await expect(drawer.locator(".line-numbers").filter({ hasText: /^2$/ })).toBeVisible();
    await expect(drawer.locator(".view-lines")).toContainText("9007199254740993");
    await page.screenshot({ path: testInfo.outputPath("manual-json-format.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(drawer.getByRole("button", { name: "Format JSON", exact: true })).toBeInViewport();
    await expect(drawer.getByRole("button", { name: "Original", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("manual-json-format-narrow.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await drawer.getByRole("button", { name: "Original", exact: true }).click();
    await expect(drawer.locator(".view-lines")).toContainText(text);
    await expect(drawer.locator(".line-numbers").filter({ hasText: /^2$/ })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Format JSON", exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await drawer.getByRole("button", { name: "Download retained content", exact: true }).click();
    const stream = await (await downloaded).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe(text);
    await drawer.getByRole("button", { name: "Set content comparison baseline", exact: true }).click();
    await expect(drawer).toContainText("Baseline: Encoded request body");
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".content-row").filter({ hasText: "Other JSON text" }).click();
    const comparison = page.getByRole("dialog", { name: "Other JSON text", exact: true });
    await expect(comparison.locator(".monaco-diff-editor")).toBeVisible();
    await expect(comparison.locator(".line-numbers").filter({ hasText: /^2$/ })).toHaveCount(0);
    await comparison.getByRole("button", { name: "Format JSON", exact: true }).click();
    await expect(comparison.locator(".line-numbers").filter({ hasText: /^2$/ })).toHaveCount(2);
    await comparison.getByRole("button", { name: "Original", exact: true }).click();
    await expect(comparison.locator(".line-numbers").filter({ hasText: /^2$/ })).toHaveCount(0);
    await comparison.getByRole("button", { name: "Close", exact: true }).click();
    for (const name of ["Non-JSON text", "Incomplete JSON"]) {
      await page.locator(".content-row").filter({ hasText: name }).click();
      const invalid = page.getByRole("dialog", { name, exact: true });
      await expect(invalid.locator(".monaco-diff-editor")).toBeVisible();
      await invalid.getByRole("button", { name: "Format JSON", exact: true }).click();
      await expect(invalid.getByText("Loaded content is not valid JSON; it may be incomplete.", { exact: true })).toBeVisible();
      await expect(invalid.locator(".line-numbers").filter({ hasText: /^2$/ })).toHaveCount(0);
      await invalid.getByRole("button", { name: "Original", exact: true }).click();
      await expect(invalid.locator(".ant-alert")).toHaveCount(0);
      await invalid.getByRole("button", { name: "Close", exact: true }).click();
    }
    expect(errors).toEqual([]);
  } finally { await server.close(); await recording.close(); }
});

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
    await expect(page.locator(".object-selection .ant-spin")).toHaveCount(0);
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
