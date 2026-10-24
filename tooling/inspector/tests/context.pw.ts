import {expect,test} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {startInspectorServer} from "../dist/server/InspectorServer.js";
import {createTestRecording} from "./recording.js";
import {InspectionRecorder} from "@agent-anything/inspection/recording";

test("request context evidence is paged, linked and usable on desktop and narrow layouts",async({page},testInfo)=>{
  const recording=await createTestRecording(), r=recording.recorder;
  const request=r.ref("model-interaction","request","parent-request","root-run");
  const links=(from:typeof request)=>[{kind:"binding" as const,from,to:request,condition:null,operation:null,sourceLocation:null,targetLocation:null}];
  r.offer({id:"planning",subject:r.ref("model-interaction","context","planning","root-run"),occurredAt:null,
    payload:{kind:"context_planning",requestId:request.id,planningId:"planning",disposition:"admitted",measurement:"estimate",inputTokens:1200,
      proxyBytes:4800,workingTarget:5000,anchorRequestId:null,limitationCount:1},
    links:links(r.ref("model-interaction","context","planning","root-run"))});
  for(let i=0;i<52;i++) {
    const subject=r.ref("model-interaction","contribution",`selection-${i}`,"root-run");
    r.offer({id:`selection-${i}`,subject,occurredAt:null,payload:{kind:"working_selection",requestId:request.id,sectionId:`source-${i}`,position:i,
      digest:`digest-${i}`,representation:"exact",protection:["first_delivery"],obligationCount:1,relationshipCount:0},links:links(subject)});
  }
  await r.flush();
  const server=await startInspectorServer({root:recording.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try {
    const url=new URL(server.launchUrl);url.searchParams.set("source",recording.sourceId);url.searchParams.set("dataset",recording.datasetId);url.searchParams.set("area","Model Interaction");
    await page.goto(url.toString());
    await page.locator(".summary-table .ant-table-row").filter({hasText:"test-model"}).first().click();
    await page.getByRole("tab",{name:"Context",exact:true}).click();
    const context=page.locator(".context-evidence");
    await expect(context.locator(".ant-table-row")).toHaveCount(50);
    await context.getByRole("button",{name:"More evidence"}).click();
    await expect(context.locator(".ant-table-row")).toHaveCount(53);
    await context.locator(".ant-table-row").first().scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath("context-desktop.png"),fullPage:true,animations:"disabled"});
    await page.setViewportSize({width:600,height:900});
    await page.screenshot({path:testInfo.outputPath("context-narrow.png"),fullPage:true,animations:"disabled"});
    await context.locator(".ant-table-row").first().getByRole("button").click();
    await expect(page.getByText("Working target",{exact:true})).toBeVisible();
  } finally {await server.close();await recording.close();}
});

test("recovery follows an explicit recording identity using a separate watermark",async({page})=>{
  const original=await createTestRecording();
  const recovered=await InspectionRecorder.create({root:original.root,application:"inspector-ui-test",name:"Recovered recording"});
  recovered.offer({id:"recovery-link",subject:recovered.ref("helarc","contribution","recovery-link","root-run"),occurredAt:null,
    payload:{kind:"recording_link",stage:"recovery_prepared",target:{sourceId:original.sourceId,datasetId:original.datasetId,runId:"root-run"},limitation:null}});
  await recovered.flush();
  const server=await startInspectorServer({root:original.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try {
    const url=new URL(server.launchUrl);url.searchParams.set("source",recovered.source.sourceId);url.searchParams.set("dataset",recovered.manifest.datasetId);
    url.searchParams.set("area","Runs");url.searchParams.set("view","Records");url.searchParams.set("record","recovery-link");
    await page.goto(url.toString());
    await page.getByRole("button",{name:"Read linked recording"}).click();
    await page.getByRole("button",{name:"Open linked recording"}).click();
    await expect(page).toHaveURL(new RegExp(original.datasetId));
    await expect(page.getByText("inspection_access_denied")).toHaveCount(0);
    await expect(page.locator(".records-table .ant-table-row").first()).toBeVisible();
  } finally {await server.close();await recovered.flush(true);await original.close();}
});
