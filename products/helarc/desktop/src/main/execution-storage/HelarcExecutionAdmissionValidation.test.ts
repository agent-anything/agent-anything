import {describe,it,expect} from "vitest";
import {bindModelAgentComposition,OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT} from "@agent-anything/model-interaction/protocol";
import {defaultProviderDraft,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import {bindHelarcNativeContextSettings} from "../context/HelarcNativeContextRunBinding.js";
import {validateHelarcExecutionAdmission,validateRetainedExecutionAdmission,originalPreparationLimitation} from "./HelarcExecutionAdmissionValidation.js";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {HelarcNativeExecutionAdmission} from "./HelarcExecutionAdmission.js";

function fixture(protocol:typeof OPENAI_RESPONSES|typeof DEEPSEEK_CHAT_COMPLETIONS|typeof OLLAMA_CHAT=OPENAI_RESPONSES):HelarcNativeExecutionAdmission {
  const configuration:ProviderConfiguration={...defaultProviderDraft(protocol.id as ProviderConfiguration["protocol"]),
    id:"configuration",revision:"original",model:"model",semanticRevision:"semantic",connectionBindingId:"connection",
    credentialBackend:"none",credentialAvailability:"missing",availabilityObservedAt:null,targetAttribution:"user_declared_route",archived:false,isDefault:false};
  const ref=(id:string)=>({id,revision:"1"});
  const bind=(id:string)=>bindModelAgentComposition({agent:ref(id),protocol,
    configuration:{protocol,configuration:{id:configuration.id,revision:configuration.revision},model:configuration.model,connectionBinding:ref("connection")},
    adapter:{protocol,implementation:ref("adapter")},task:{purpose:ref("task"),input:{protocol,implementation:ref("input")},
      interpreter:{protocol,implementation:ref("interpret")}},auxiliary:[]});
  // Environment sealing and common Run validation belong to the database boundary.
  return {version:4,rootRunId:"root",productRunId:"product",createdAt:"2026-11-16T00:00:00Z",commandEnvironment:{},
    model:{configuration,connection:{kind:"connection",bindingId:"connection",pinId:"product:provider-connection",acceptanceId:"product"},root:bind("root-agent"),delegated:bind("worker")},
    contextBinding:bindHelarcNativeContextSettings({autoRepresentation:true,observations:[]},configuration)} as unknown as HelarcNativeExecutionAdmission;
}
describe("Original native admission relationships",()=>{
  it.each([OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT])("accepts $id without credentials or legacy Provider fields",protocol=>{
    const original=fixture(protocol);expect(()=>validateHelarcExecutionAdmission(original)).not.toThrow();
    expect(Object.hasOwn(original,"providerProfile")).toBe(false);
  });
  it("rejects changed configuration, connection custody and Child composition",()=>{
    const a=fixture();
    const invalid=[{...a,model:{...a.model,configuration:{...a.model.configuration,revision:"later"}}},
      {...a,model:{...a.model,configuration:{...a.model.configuration,model:""}}},
      {...a,model:{...a.model,connection:{...a.model.connection,pinId:"someone-else:provider-connection"}}},
      {...a,model:{...a.model,connection:{...a.model.connection,acceptanceId:"other-product"}}},
      {...a,model:{...a.model,delegated:fixture(OLLAMA_CHAT).model.delegated}},
      {...a,providerProfile:{id:"legacy"}},
      {...a,contextBinding:bindHelarcNativeContextSettings({autoRepresentation:true,observations:[]},{...a.model.configuration,semanticRevision:"later"})}];
    for(const value of invalid)expect(()=>validateHelarcExecutionAdmission(value)).toThrow();
    expect(()=>validateHelarcExecutionAdmission(a)).not.toThrow();
  });
  it("keeps native policy availability separate from evidence and delegation integrity",()=>{
    const a=fixture(),{id,...body}=a.contextBinding,prior={...body,policy:{id:body.policy.id,revision:"earlier"}};
    const old={...a,contextBinding:{...prior,id:"native-context-binding:"+modelInputValueDigest(prior)}};
    expect(()=>validateRetainedExecutionAdmission(old)).not.toThrow();
    expect(originalPreparationLimitation(old)).toMatchObject({component:"preparation_policy",required:body.policy.id+"@earlier"});
    expect(()=>validateHelarcExecutionAdmission(old)).toThrow("native_context_run_policy_unavailable");
    expect(()=>validateRetainedExecutionAdmission({...old,contextBinding:{...old.contextBinding,id}})).toThrow("binding_invalid");
    expect(()=>validateRetainedExecutionAdmission({...old,model:{...old.model,delegated:fixture(OLLAMA_CHAT).model.delegated}})).toThrow();
  });
});
