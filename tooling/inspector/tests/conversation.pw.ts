import {expect, test} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {startInspectorServer} from "../dist/server/InspectorServer.js";
import {createTestRecording} from "./recording.js";

test("request conversation entries preserve order, source navigation and bounded paging", async ({page}, testInfo) => {
  const recording = await createTestRecording();
  const {recorder} = recording;
  const request = recorder.ref("model-interaction", "request", "conversation-request", "root-run");
  const source = recorder.ref("runtime", "contribution", "child-delivery", "child-investigation", "1");
  recorder.offer({id: "child-delivery-fact", subject: source, occurredAt: null,
    payload: {kind: "event", name: "Original Child contribution", sequence: null, code: null},
    contents: [{name: "Original contribution", stage: "owner", class: "provider", mediaType: "text/plain", value: "The original Child result."}]});
  recorder.offer({id: "conversation-request-record", subject: request, occurredAt: null,
    payload: {kind: "request", purpose: "conversation-smoke", providerId: "fixture", model: "fixture", compositionId: "composition", messageCount: 1, toolCount: 0}});
  for (let index = 0; index < 55; index++) {
    const presentation = recorder.ref("agent-runtime", "contribution", `entry-${index}`, "root-run", "1");
    const link = {condition: null, sourceLocation: null, targetLocation: null};
    recorder.offer({id: `conversation-entry-${index}`, subject: presentation, occurredAt: null,
      payload: {kind: "conversation", stage: "included", purpose: index === 0 ? "imported_history" : "selected_material",
        author: "host", role: "user", recipientRunId: "root-run", originRunId: index === 0 ? "child-investigation" : null,
        requestId: request.id, attemptId: "http-attempt-1", position: index, presenter: "fixture@1", digest: `digest-${index}`,
        delivery: index === 0 ? "import" : "new", sourceCount: 1},
      links: [{...link, kind: "transforms", from: source, to: presentation, operation: index === 0 ? "scoped_history_import" : "presentation"},
        {...link, kind: "includes", from: presentation, to: request, operation: "model_input"}]});
  }
  await recorder.flush();
  expect(recorder.health().rejected).toBe(0);
  const server = await startInspectorServer({root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url))});
  const url = new URL(server.launchUrl);
  for (const [key, value] of Object.entries({source: recording.sourceId, dataset: recording.datasetId, area: "Model Interaction", view: "Requests", run: "root-run"})) url.searchParams.set(key, value);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url.toString());
    await page.locator(".summary-table .ant-table-row").filter({hasText: "conversation-smoke"}).click();
    const delivery = page.locator(".conversation-delivery");
    await expect(delivery.locator(".ant-table-row")).toHaveCount(50);
    await expect(delivery).toContainText("child-investigation");
    await expect(delivery).toContainText("host / user");
    await delivery.getByRole("button", {name: /More entries/}).click();
    await expect(delivery.locator(".ant-table-row")).toHaveCount(55);
    await expect(delivery.getByRole("button", {name: /More entries/})).toHaveCount(0);
    await delivery.locator(".ant-table-row").first().getByRole("button").click();
    const fact = page.getByRole("dialog", {name: "Recorded fact", exact: true});
    await expect(fact).toContainText("child-investigation");
    await fact.getByRole("button", {name: "Inspect transforms relation", exact: true}).click();
    const relation = page.getByRole("dialog", {name: "Recorded relation", exact: true});
    await relation.locator(".relation-endpoint").first().getByRole("button", {name: "Open object", exact: true}).click();
    const sourceDetail = page.getByRole("dialog", {name: "Related object", exact: true});
    await expect(sourceDetail).toContainText("Original Child contribution");
    expect(new URL(page.url()).searchParams.get("run")).toBe("root-run");
    await sourceDetail.getByRole("button", {name: "Close", exact: true}).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({path: testInfo.outputPath("conversation-desktop.png"), fullPage: true});
    await page.setViewportSize({width: 800, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path: testInfo.outputPath("conversation-narrow.png"), fullPage: true});
    expect(errors).toEqual([]);
  } finally {await server.close(); await recording.close();}
});
