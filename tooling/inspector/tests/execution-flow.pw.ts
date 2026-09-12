import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createExecutionFlowDefinition, ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import { ExecutionFlowInspectionAdapter } from "@agent-anything/inspection/adapters";
import { startInspectorServer } from "../dist/server/InspectorServer.js";
import { createTestRecording } from "./recording.js";

test("execution flow retains exact occurrences, child navigation and manual refresh", async ({page}, testInfo) => {
  const recording = await createTestRecording();
  const observer = new ExecutionFlowInspectionAdapter(recording.recorder);
  const definition = createExecutionFlowDefinition({owner:"runtime",id:"run-execution",revision:"ui-1",label:"Core Loop",description:"Deterministic flow navigation fixture",steps:[
    {id:"initialize",label:"Initialize Run",kind:"entry",checks:[]},
    {id:"controller",label:"Invoke Controller",kind:"call",checks:["current_basis"]},
    {id:"complete",label:"Complete Run",kind:"exit",checks:["pending_work"]},
  ],transitions:[{id:"start",from:"initialize",to:"controller",label:"Ready"},{id:"next",from:"controller",to:"controller",label:"Next decision"},{id:"complete",from:"controller",to:"complete",label:"Completion candidate"}],entryStepIds:["initialize"],exitStepIds:["complete"]});
  const root = new ExecutionFlowPath(definition,{observer},"root-run");
  root.advance("initialize");
  const first = root.advance("controller"); first.check("current_basis","passed",{runRevision:1});
  const child = new ExecutionFlowPath(definition,root.callContext,"child-investigation");
  child.advance("initialize");child.advance("controller");child.advance("complete");child.close("returned");
  root.advance("controller").check("current_basis","passed",{runRevision:2});
  await recording.recorder.flush();
  const server=await startInspectorServer({root:recording.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  const errors: string[]=[];page.on("pageerror",error=>errors.push(error.message));
  try {
    const url=new URL(server.launchUrl);
    url.searchParams.set("source",recording.sourceId);url.searchParams.set("dataset",recording.datasetId);url.searchParams.set("view","Execution Flow");
    url.searchParams.set("subject",JSON.stringify(recording.recorder.ref("runtime","run","root-run","root-run")));
    await page.goto(url.toString());
    await expect(page.locator(".flow-step-node")).toHaveCount(3);
    await expect(page.locator(".flow-occurrences .ant-table-row")).toHaveCount(3);
    await page.locator(".flow-occurrences .ant-table-row").nth(1).click();
    await page.getByRole("tab",{name:"Checks (1)",exact:true}).click();
    await expect(page.locator(".flow-details")).toContainText("current_basis");
    await expect(page.locator(".flow-details")).toContainText('"runRevision": 1');
    await page.screenshot({path:testInfo.outputPath("flow-desktop.png"),fullPage:true,animations:"disabled"});
    await page.locator(".flow-relations").getByRole("button",{name:`call: flow-invocation / ${child.ref.invocationId}`}).click();
    await expect.poll(()=>new URL(page.url()).searchParams.get("flowRun")).toBe("child-investigation");
    await expect(page.locator(".flow-occurrences .ant-table-row")).toHaveCount(3);
    await page.getByRole("button",{name:"Previous flow",exact:true}).click();
    await expect.poll(()=>new URL(page.url()).searchParams.get("flowOccurrence")).toBe(first.ref.stepExecutionId);
    root.advance("complete").check("pending_work","passed",{pendingCount:0});root.close("returned");
    await recording.recorder.flush();
    await expect(page.locator(".flow-occurrences .ant-table-row")).toHaveCount(3);
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    await expect(page.locator(".flow-occurrences .ant-table-row")).toHaveCount(4);
    expect(new URL(page.url()).searchParams.get("flowOccurrence")).toBe(first.ref.stepExecutionId);
    await page.setViewportSize({width:390,height:844});
    await page.getByText("Occurrences",{exact:true}).click();
    await expect(page.locator(".flow-occurrences .ant-table-row")).toHaveCount(4);
    await page.locator(".flow-occurrences .ant-table-row").last().click();
    await expect(page.locator(".flow-details")).toContainText("Complete Run");
    await page.screenshot({path:testInfo.outputPath("flow-narrow.png"),fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await server.close();await recording.close();}
});
