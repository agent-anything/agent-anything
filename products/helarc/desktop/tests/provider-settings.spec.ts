import { test, expect } from "@playwright/test";

test("Protocol browsing, saved credentials, explicit discovery and activation are separate",async({page},testInfo)=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const profiles:any[]=[],updates=new Map(),calls={save:0,query:0,activate:0};
    (window as any).providerCalls=calls;
    const snapshot:any={execution:"idle",projects:[],selectedProjectId:null,status:"idle",workspace:null,workspaceProfiles:[],acceptedTask:null,activeThread:null,threadSummaries:[],run:null,error:null,
      provider:{configured:false,nativeToolInteraction:{supported:false},profiles:[],activeProfile:null,error:{code:"missing",message:"No provider"}}};
    const ok=(value:any)=>({ok:true,value});
    (window as any).helarc={bridgeVersion:11,productId:"helarc",listRecoverableWork:async()=>[],getSnapshot:async()=>structuredClone(snapshot),subscribeSnapshot:()=>()=>{},
      providerConfigurations:{
        list:async()=>ok({configurations:structuredClone(profiles),defaultSelection:null}),
        receipt:async(id:string)=>ok(updates.get(id)??null),
        previewPolicy:async({draft}:any)=>{
          const n=draft.native,base=JSON.stringify([draft.protocol,draft.baseUrl,draft.model,n.organization,n.project]);
          const target=JSON.stringify([base,[n.reasoningEffort,n.transport,n.continuity,n.background,n.store,n.stream]]);
          if(draft.inRequestCompaction&&draft.inRequestCompaction.target!==target)return {ok:false,code:"provider_compaction_target_changed"};
          return ok(draft.inRequestCompaction??{revision:"1",target,origin:"unassessed",basis:"test",reviewedAt:"2026-11-24",support:"unassessed",profiles:[],trigger:{windowTokens:null,thresholdTokens:null,basis:"test"}});
        },
        credentialSettings:async()=>ok({windowsAvailable:true,selection:{source:"windows-managed"}}),
        save:async(input:any)=>{
          calls.save++;if(updates.has(input.updateId))return ok(updates.get(input.updateId));
          const saved={...structuredClone(input.draft),id:input.configurationId,revision:crypto.randomUUID(),semanticRevision:"semantic",connectionBindingId:`binding-${calls.save}`,
            credentialBackend:input.credential.storage??"windows-managed",credentialAvailability:"unchecked",availabilityObservedAt:null,targetAttribution:"provider_endpoint",isDefault:false,archived:false};
          const i=profiles.findIndex(c=>c.id===saved.id);if(i<0)profiles.push(saved);else profiles[i]=saved;
          const receipt={updateId:input.updateId,disposition:"committed",configuration:saved};updates.set(input.updateId,receipt);return ok(receipt);
        },
        discover:async(input:any)=>{calls.query++;return ok({configurationId:input.id,revision:input.revision,models:["fixture-model"],capabilityEvidence:"unknown",observedAt:new Date().toISOString()});},
        eligibility:async(input:any)=>ok({available:!!profiles.find(c=>c.id===input.id)?.model,reason:null}),
        activate:async(input:any)=>{calls.activate++;const saved=profiles.find(c=>c.id===input.id);saved.isDefault=true;return ok(saved);},
        archive:async(input:any)=>{profiles.splice(profiles.findIndex(c=>c.id===input.id),1);return ok(null);},
        dependencies:async()=>ok({bindingRevision:1,bindingOutstanding:2,credentialOutstanding:2,credentialBindings:1}),
      }};
  });
  await page.goto("/");await page.getByRole("button",{name:"Open settings",exact:true}).click();
  const panel=page.getByRole("region",{name:"Provider configuration"});
  await panel.getByLabel("Model Interaction Protocol").selectOption("openai.responses");
  await expect(panel.getByLabel("Configuration name")).toHaveCount(0);
  await panel.getByRole("button",{name:"New configuration",exact:true}).click();
  await expect(panel.getByLabel("Credential source")).toHaveValue("windows-managed");
  await panel.getByLabel("New API key").fill("synthetic-ui-test-key");
  await panel.getByRole("button",{name:"Save configuration",exact:true}).click();
  await expect(panel.getByLabel("Credential source")).toHaveValue("keep");
  expect(await page.evaluate(()=>(window as any).providerCalls)).toEqual({save:1,query:0,activate:0});
  await expect(panel.getByRole("button",{name:"Use as default"})).toBeDisabled();
  await panel.getByRole("button",{name:"Query models"}).click();
  await expect(panel.getByLabel("Available models").locator('option[value="fixture-model"]')).toHaveCount(1);
  await panel.getByLabel("Available models").selectOption("fixture-model");
  await panel.getByText("In-request compaction use policy",{exact:true}).click();
  const policy=panel.getByLabel("In-request compaction use policy",{exact:true});
  const original=JSON.parse(await policy.inputValue());
  await policy.fill(JSON.stringify({...original,target:"previous-target"}));
  await expect(panel.getByText("provider_compaction_target_changed")).toBeVisible();
  await expect(panel.getByRole("button",{name:"Save configuration",exact:true})).toBeDisabled();
  await panel.getByRole("button",{name:"Restore documentation defaults"}).click();
  await expect(panel.getByRole("button",{name:"Save configuration",exact:true})).toBeEnabled();
  await panel.getByRole("button",{name:"Save configuration",exact:true}).click();
  await expect(panel.getByRole("button",{name:"Use as default"})).toBeEnabled();
  expect(await page.evaluate(()=>(window as any).providerCalls.activate)).toBe(0);
  await panel.getByRole("button",{name:"Use as default"}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).providerCalls.activate)).toBe(1);
  await panel.getByLabel("Model Interaction Protocol").selectOption("ollama.chat");
  await expect(panel.getByLabel("Model",{exact:true})).toHaveCount(0);
  await panel.getByLabel("Model Interaction Protocol").selectOption("openai.responses");
  const option=await panel.getByLabel("Saved configuration").locator("option").nth(1).getAttribute("value");
  await panel.getByLabel("Saved configuration").selectOption(option!);
  await expect(panel.getByLabel("Model",{exact:true})).toHaveValue("fixture-model");
  expect(await page.evaluate(()=>(window as any).providerCalls)).toEqual({save:2,query:1,activate:1});
  await page.screenshot({path:testInfo.outputPath("protocol-settings.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:testInfo.outputPath("protocol-settings-mobile.png"),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"Close settings",exact:true}).click();
  await page.locator("details.wb-context > summary").click();
  const nextTask=page.getByLabel("Next task protocol configuration");
  await expect(nextTask.locator("optgroup option")).toHaveCount(1);
  await nextTask.selectOption((await nextTask.locator("optgroup option").getAttribute("value"))!);
  expect(await page.evaluate(()=>(window as any).providerCalls)).toEqual({save:2,query:1,activate:1});
  expect(errors).toEqual([]);
});
