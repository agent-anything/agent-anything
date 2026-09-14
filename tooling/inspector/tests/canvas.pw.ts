import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInspectorServer } from "../src/server/InspectorServer.js";
import { createTestRecording } from "./recording.js";

test("all investigation canvases resize without replacing their charts or reading new data", async ({page}, testInfo) => {
  const recording = await createTestRecording(true);
  const server = await startInspectorServer({root:recording.root, assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let reads = 0;
  page.on("request", request => {if (request.url().includes("/api/")) reads++;});
  try {
    await page.goto(server.launchUrl);
    await expect(page.getByRole("combobox",{name:"Source",exact:true})).toBeVisible();
    for (const view of ["Hierarchy", "Dependencies", "Lifecycle", "Data Flow", "Timeline"]) {
      const url = new URL(server.url);
      url.searchParams.set("source",recording.sourceId);
      url.searchParams.set("dataset",recording.datasetId);
      url.searchParams.set("view",view);
      url.searchParams.set("subject",JSON.stringify(recording.recorder.ref("runtime","run","root-run","root-run")));
      await page.goto(url.toString());
      const frame = page.getByRole("region", {name:`${view} canvas`,exact:true});
      const chart = frame.locator(view === "Timeline" ? ".vis-timeline" : ".react-flow");
      await expect(chart).toBeVisible();
      if (view === "Hierarchy" || view === "Dependencies" || view === "Data Flow") await expect(frame.locator('[data-layout="ready"]')).toBeVisible();
      const node = await chart.elementHandle();
      const graphViewport = frame.locator(".react-flow__viewport");
      const transform = view === "Timeline" ? null : await graphViewport.getAttribute("style");
      const bounds = (await chart.boundingBox())!;
      const previousReads = reads;
      await frame.getByRole("button", {name:`Expand ${view} canvas`,exact:true}).click();
      await expect(frame).toHaveAttribute("data-expanded","true");
      await expect.poll(async () => (await chart.boundingBox())!.width).toBeGreaterThan(bounds.width);
      expect(await node!.evaluate(element => element.isConnected)).toBe(true);
      if (transform) await expect(graphViewport).toHaveAttribute("style", transform);
      if (view === "Data Flow") {
        await page.screenshot({path:testInfo.outputPath("canvas-expanded.png")});
        await frame.locator(".react-flow__edge-textwrapper").first().click();
        const drawer = page.getByRole("dialog",{name:"Recorded relation",exact:true});
        await expect(drawer).toBeVisible();
        await drawer.press("Escape");
        await expect(drawer).not.toBeVisible();
        await expect(frame).toHaveAttribute("data-expanded","true");
      }
      await frame.getByRole("button", {name:`Restore ${view} canvas`,exact:true}).press("Escape");
      await expect(frame).toHaveAttribute("data-expanded","false");
      await expect.poll(async () => Math.abs((await chart.boundingBox())!.height - bounds.height)).toBeLessThan(2);
      expect(await node!.evaluate(element => element.isConnected)).toBe(true);
      if (transform) await expect(graphViewport).toHaveAttribute("style", transform);
      expect(reads).toBe(previousReads);
      if (view === "Data Flow" || view === "Lifecycle") {
        const bar = page.locator(".canvas-split > .ant-splitter-bar .ant-splitter-bar-dragger");
        const box = (await bar.boundingBox())!;
        const before = (await frame.boundingBox())!.height;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 65, {steps:5});
        await page.mouse.up();
        await expect.poll(async () => (await frame.boundingBox())!.height).toBeGreaterThan(before + 20);
        if (transform) await expect(graphViewport).toHaveAttribute("style", transform);
      }
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByRole("button",{name:"Expand Timeline canvas",exact:true}).click();
    await expect(page.locator(".canvas-expanded .vis-timeline")).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("canvas-narrow.png")});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole("button",{name:"Restore Timeline canvas",exact:true}).click();
    expect(errors).toEqual([]);
  } finally {await server.close();await recording.close();}
});
