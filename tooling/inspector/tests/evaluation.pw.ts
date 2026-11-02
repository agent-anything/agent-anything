import {test,expect} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {startInspectorServer} from "../dist/server/InspectorServer.js";
import {createTestRecording} from "./recording.js";
import {InspectionQueryService} from "@agent-anything/inspection/query";
test("report works without a live Run and rechecks explicit export permission",async({page},info)=>{
  const fixture=await createTestRecording(),r=fixture.recorder,q=new InspectionQueryService(fixture.root);
  const original=r.ref("context-test","contribution","original-input","root-run","1");
  r.offer({id:"original-input",subject:original,occurredAt:null,payload:{kind:"process_evidence",version:"1",origin:{owner:"context-test",id:original.id,runId:"root-run",revision:"1"},digest:"original",subject:original,category:"input",name:"original-input",status:"accepted",purpose:"task",recipient:{runId:"root-run",recipient:"assistant",purpose:"task"},relationCount:0}});
  await r.flush();const before=await q.query({kind:"get_snapshot",sourceId:fixture.sourceId,datasetId:fixture.datasetId});
  const subject=r.ref("evaluation","artifact","report");
  const projection={version:"1",id:"report",comparison:"C01",target:"Isolated target",startingBoundary:"before_adoption",scope:"Fixed candidate subsequent use",expectations:["Source facts"],exclusions:["Generation cost"],limitations:["No general advantage claim"],trials:[{id:"trial",arm:"candidate",repetition:1,execution:"completed",capture:"complete",cleanup:"cleaned",grades:[{dimension:"preservation",verdict:"insufficient_evidence",method:"deterministic",rationale:"Production checks do not establish independent preservation"}],measurements:[{name:"currency_cost",role:"target",unit:"currency",value:null,unavailableReason:"no_verified_tariff"}],evidence:[{...before.selection!,recordId:"original-input",label:"Original input"}]}]};
  r.offer({subject,occurredAt:null,payload:{kind:"evaluation_report",reportId:"report",comparison:"C01",target:"Isolated target",startingBoundary:"before_adoption",status:"complete",trialCount:1,limitationCount:1},links:[{from:subject,to:original,kind:"observes",condition:null,operation:"fixed scope",sourceLocation:null,targetLocation:null}],contents:[{name:"Evaluation report",class:"execution",stage:"evaluation-report",mediaType:"application/json",value:projection}]});await r.flush();
  const server=await startInspectorServer({root:fixture.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try{
    const url=new URL(server.launchUrl);url.searchParams.set("source",fixture.sourceId);url.searchParams.set("dataset",fixture.datasetId);url.searchParams.set("area","Context Process");url.searchParams.set("cpView","Evaluation");
    await page.goto(url.toString());await page.getByRole("button",{name:"C01 / report",exact:true}).click();
    await expect(page.getByTestId("process-evaluation")).toContainText("no_verified_tariff");
    await page.screenshot({path:info.outputPath("evaluation-desktop.png"),fullPage:true});
    await page.setViewportSize({width:600,height:900});await page.screenshot({path:info.outputPath("evaluation-narrow.png"),fullPage:true});
    expect(await page.locator("body").evaluate(el=>el.scrollWidth<=600)).toBe(true);await page.setViewportSize({width:1440,height:960});
    await page.getByRole("button",{name:"Export evaluation report",exact:true}).click();const modal=page.getByRole("dialog",{name:"Export evaluation report",exact:true});
    await expect(modal.getByRole("button",{name:"Export",exact:true})).toBeDisabled();await modal.getByRole("checkbox").check();
    const download=page.waitForEvent("download");await modal.getByRole("button",{name:"Export",exact:true}).click();expect((await download).suggestedFilename()).toBe("evaluation-report.json");
    await page.getByRole("button",{name:`Original input @ ${before.selection!.watermark}`,exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Process evidence",exact:true})).toBeVisible();
    const manifest=JSON.parse(new URL(page.url()).searchParams.get("cpManifest")!);expect(manifest.recordings[0].watermark).toBe(before.selection!.watermark);
    await page.goto(url.toString().replace(/#.*$/, ""));await page.getByRole("button",{name:"C01 / report",exact:true}).click();
    await page.getByRole("button",{name:"Export evaluation report",exact:true}).click();await modal.getByRole("checkbox").check();
    r.setPolicy({revision:"revoked",enabled:true,definition:true,agent:true,provider:true,execution:false});await r.flush();
    await modal.getByRole("button",{name:"Export",exact:true}).click();await expect(page.getByTestId("process-evaluation")).toContainText(/denied/);
  }finally{await server.close();await q.close();await fixture.close();}
});

test("actual isolated evaluation report follows its recorded cross-recording evidence",async({page},info)=>{
  const root=process.env.INSPECTOR_EVALUATION_RECORDING;test.skip(!root,"Supply an isolated comparison report recording");
  const q=new InspectionQueryService(root!),sources=(await q.query({kind:"list_sources"})).sources;
  const source=sources.find(s=>s.application==="agent-anything-process-evaluation")!;
  const dataset=(await q.query({kind:"list_datasets",sourceId:source.sourceId})).datasets[0]!;
  const server=await startInspectorServer({root:root!,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try{const url=new URL(server.launchUrl);url.searchParams.set("source",source.sourceId);url.searchParams.set("dataset",dataset.datasetId);url.searchParams.set("area","Context Process");url.searchParams.set("cpView","Evaluation");
    await page.goto(url.toString());await page.getByTestId("process-evaluation").getByRole("button",{name:/^C0\d \//}).first().click();
    await expect(page.getByRole("button",{name:"Export evaluation report",exact:true})).toBeVisible();
    await expect(page.getByTestId("process-evaluation")).toContainText("subsequent_use");await page.screenshot({path:info.outputPath("actual-evaluation-report.png"),fullPage:true});
    await page.setViewportSize({width:600,height:900});expect(await page.getByTestId("process-evaluation").evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath("actual-evaluation-narrow.png"),fullPage:true});await page.setViewportSize({width:1440,height:960});
    await page.getByRole("button",{name:/^Original process evidence @/}).last().click();await expect(page.getByRole("dialog",{name:"Process evidence",exact:true})).toBeVisible();
    expect(JSON.parse(new URL(page.url()).searchParams.get("cpManifest")!).recordings).toHaveLength(2);
  }finally{await server.close();await q.close();}
});
