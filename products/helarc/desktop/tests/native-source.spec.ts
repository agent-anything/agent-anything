import {test,expect,_electron} from "@playwright/test";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
test("original native delegation records remain readable in Desktop across reload",async({},info)=>{
  test.skip(!process.env.HELARC_NATIVE_PRODUCT,"Requires retained Electron native delegation evidence");
  const {projection}=JSON.parse(await readFile(process.env.HELARC_NATIVE_PRODUCT!,"utf8"));
  const labels=projection.product.presentation.labels as {runId:string;parentRunId:string|null;siblingOrdinal:number|null}[];
  const nested=labels.find(l=>l.parentRunId&&l.parentRunId!=="root")!;
  const parent=labels.find(l=>l.runId===nested.parentRunId)!;
  const sibling=labels.find(l=>l.parentRunId==="root"&&l.runId!==parent.runId)!;
  const parentName=`Subtask ${parent.siblingOrdinal}`,childName=`${parentName}.${nested.siblingOrdinal}`,siblingName=`Subtask ${sibling.siblingOrdinal}`;
  const path=fileURLToPath(new URL("./native-source.html",import.meta.url)).replaceAll("\\","/");
  const env={...process.env,HELARC_NATIVE_UI_DATA:await mkdtemp(join(tmpdir(),"helarc-native-ui-")),HELARC_NATIVE_UI_URL:`http://127.0.0.1:5177/@fs/${path}`};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({args:[fileURLToPath(new URL("./native-source-electron.mjs",import.meta.url))],env});
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await expect(page.getByRole("button",{name:`Expand ${parentName}`,exact:true})).toBeVisible();
    const ids=await page.locator(".wb-message[data-entry]").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("data-entry")));
    await page.getByRole("button",{name:`Expand ${parentName}`,exact:true}).click();
    await expect(page.getByRole("button",{name:`Expand ${childName}`,exact:true})).toBeVisible();
    await page.getByRole("button",{name:`Expand ${childName}`,exact:true}).click();
    await expect(page.getByRole("region",{name:childName,exact:true})).toContainText("7391");
    await page.screenshot({path:info.outputPath("native-desktop-wide.png"),fullPage:true});
    await page.reload();await expect(page.getByRole("button",{name:`Expand ${parentName}`,exact:true})).toBeVisible();
    expect(await page.locator(".wb-message[data-entry]").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("data-entry")))).toEqual(ids);
    await page.setViewportSize({width:390,height:844});
    await page.getByRole("button",{name:`Expand ${siblingName}`,exact:true}).click();
    await expect(page.getByRole("region",{name:siblingName,exact:true})).toContainText("8422");
    await page.screenshot({path:info.outputPath("native-desktop-narrow.png"),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally{await app.close();}
});
