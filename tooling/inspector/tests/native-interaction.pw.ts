import {test,expect} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {nativeInspectionRecords} from "@agent-anything/inspection/adapters";
import {startInspectorServer} from "../dist/server/InspectorServer.js";
import {createTestRecording} from "./recording.js";

test("native protocol views retain original interpretation, protected content and scope across reload",async({page},info)=>{
  const f=await createTestRecording(),r=f.recorder;
  const protocols=["openai.responses","deepseek.chat-completions","ollama.chat"];
  for(const [i,id]of protocols.entries()){
    const subject=r.ref("protocol-execution","model-activity",`activity-${i}`,"root-run");
    const binding={subject,protocol:{id,revision:"1"},interpretation:{id:`${id}.adapter`,revision:"1"}};
    r.offer({id:`binding-${i}`,subject,occurredAt:null,payload:{kind:"native_interaction",protocol:id,protocolRevision:"1",
      interpretation:binding.interpretation.id,interpretationRevision:"1",purpose:"helarc.controller",recipientId:"root-run",compositionDigest:"original-composition",model:"test"}});
    const value=i===0?{id:"response-original",object:"response",status:"completed",output:[{type:"message",id:"message-original",content:[{type:"output_text",text:"Original native reply"}]}],usage:{input_tokens:123,output_tokens:8,input_tokens_details:{cached_tokens:20}}}:
      i===1?{id:"completion-original",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"Original native reply"}}]}:
        {message:{role:"assistant",content:"Original native reply"},done:true,eval_count:8};
    for(const fact of nativeInspectionRecords(binding,{identity:"observation",category:"observation",operationId:"op",occurredAt:null,origin:"import",source:subject,value}))r.offer(fact);
    if(i===0)for(const fact of nativeInspectionRecords({...binding,interpretation:{...binding.interpretation,revision:"unknown"}},
      {identity:"unreadable",category:"coverage",operationId:"op",occurredAt:null,origin:"import",source:subject,value:{original:"Protected raw evidence"}}))r.offer(fact);
  }
  await r.flush();
  const server=await startInspectorServer({root:f.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  const url=new URL(server.launchUrl);url.searchParams.set("source",f.sourceId);url.searchParams.set("dataset",f.datasetId);url.searchParams.set("area","Model Interaction");
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
    await page.goto(url.toString());
    const native=page.locator(".native-interactions");
    await native.getByRole("button",{name:"OpenAI Responses",exact:true}).click();
    await expect(native).toContainText("openai.responses.adapter / 1");
    await native.getByRole("tab",{name:"Responses and Items",exact:true}).click();
    await native.getByRole("button",{name:"message",exact:true}).click();
    const content=page.getByRole("dialog",{name:"message",exact:true});
    await expect(content).toContainText("Original native reply");
    await page.screenshot({path:info.outputPath("native-content-wide.png"),fullPage:true});
    await content.getByRole("button",{name:"Close",exact:true}).click();
    await page.reload();await expect(native).toContainText("openai.responses.adapter / 1");
    await native.getByRole("tab",{name:"Usage and cost evidence",exact:true}).click();
    await expect(native).toContainText("cached_tokens");
    await native.getByRole("tab",{name:"Coverage",exact:true}).click();await expect(native).toContainText("native_reader_unavailable");
    await native.getByRole("button",{name:"DeepSeek Chat Completions",exact:true}).click();
    await expect(native.getByRole("tab",{name:"Choices and messages",exact:true})).toBeVisible();
    await native.getByRole("button",{name:"Ollama Chat",exact:true}).click();
    await native.getByRole("tab",{name:"Messages",exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await expect(native.getByRole("button",{name:"message",exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("native-narrow.png"),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  }finally{await server.close();await f.close();}
});
