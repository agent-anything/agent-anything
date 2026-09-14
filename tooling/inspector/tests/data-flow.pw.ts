import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInspectorServer } from "../src/server/InspectorServer.js";
import { createTestRecording } from "./recording.js";

test("data flow pages a focused neighborhood, follows cross-Run evidence and preserves navigation", async ({page}, testInfo) => {
  const recording = await createTestRecording();
  const request = recording.recorder.ref("model-interaction","request","parent-request","root-run");
  const childContext = recording.recorder.ref("context","context","child-only-context","child-investigation");
  const relation = (from: typeof request, to: typeof request) => ({from,to,kind:"includes" as const,operation:null,condition:null,sourceLocation:null,targetLocation:null});
  recording.recorder.offer({subject:childContext,occurredAt:null,payload:{kind:"event",name:"Child Context",sequence:null,code:null}});
  for (let index=0;index<10;index++) {
    const subject=recording.recorder.ref("context","contribution",`piece-${index}`,"child-investigation");
    recording.recorder.offer({subject,occurredAt:null,payload:{kind:"event",name:`Piece ${index}`,sequence:null,code:null},links:[relation(subject,request),...(index===3?[relation(subject,childContext)]:[])]});
  }
  await recording.recorder.flush();
  const server = await startInspectorServer({root:recording.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  try {
    const url=new URL(server.launchUrl);url.searchParams.set("source",recording.sourceId);url.searchParams.set("dataset",recording.datasetId);url.searchParams.set("run","root-run");url.searchParams.set("view","Data Flow");
    await page.goto(url.toString());
    await expect(page.locator(".data-node")).toHaveCount(4);
    await expect(page.locator(".data-direction").first()).toContainText("1-3 / 11");
    await page.screenshot({path:testInfo.outputPath("data-flow-focused.png"),fullPage:true});
    await page.getByRole("button",{name:"Next incoming",exact:true}).click();
    await expect(page.locator(".data-direction").first()).toContainText("4-6 / 11");
    await page.locator(".data-node").filter({hasText:"Piece 3"}).click();
    await expect(page.locator(".data-focus-summary")).toContainText("Piece 3");
    expect(new URL(page.url()).searchParams.get("run")).toBe("root-run");
    await expect(page.locator(".data-node").filter({hasText:"Child Context"})).toBeVisible();
    await page.locator(".data-relations-table .ant-table-row").filter({hasText:"Child Context"}).click();
    const drawer=page.getByRole("dialog",{name:"Recorded relation",exact:true});
    await expect(drawer).toContainText("Location not recorded");
    await drawer.getByRole("button",{name:"Open establishing record",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Recorded fact",exact:true})).toContainText("Piece 3");
    await page.getByRole("dialog",{name:"Recorded fact",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await drawer.getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("button",{name:"Reset data flow focus",exact:true}).click();
    await expect(page.locator(".data-focus-summary")).toContainText("parent-request");
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole("combobox",{name:"Data flow focus",exact:true})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("data-flow-narrow.png"),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await server.close();await recording.close();}
});
