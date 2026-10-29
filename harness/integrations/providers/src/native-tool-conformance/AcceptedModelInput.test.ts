import {describe,expect,it} from "vitest";
import {OllamaProvider} from "../ollama/OllamaProvider.js";
import {OpenAICompatibleProvider} from "../openai-compatible/OpenAICompatibleProvider.js";
import {createNativeProviderRequest} from "./NativeToolInteractionTestSupport.js";
import type {FetchLike} from "../http/ProviderHttpTransport.js";

const limit={maximumBytes:1000000,source:"host_configured" as const,revision:"1"};
const ollama={baseUrl:"http://localhost:11435",model:"test",timeoutMs:5000,runtime:{contextWindowTokens:16384},nativeToolInteraction:{supported:true},requestBodyTransportLimit:limit};
const openai={baseUrl:"https://example.test/v1",model:"test",apiKey:"original-secret",timeoutMs:5000,nativeToolInteraction:{supported:true},requestBodyTransportLimit:limit};
describe("accepted model-related encoding",()=>{
  it.each(["ollama","openai"])("dispatches exact durable bytes and rejects changed targets for %s",async name=>{
    const sent:string[]=[];
    const fetch:FetchLike=async(_url,init)=>{sent.push(init.body);return {ok:true,status:200,json:async()=>name==="ollama"?
      {message:{role:"assistant",content:"done"},done:true,done_reason:"stop"}:{choices:[{message:{role:"assistant",content:"done"},finish_reason:"stop"}]}};};
    const provider=name==="ollama"?new OllamaProvider(ollama,fetch):new OpenAICompatibleProvider(openai,fetch);
    const request=createNativeProviderRequest(provider),encoded=provider.encodeInput(request,"buffered"),context={signal:new AbortController().signal,interruption:null};
    const restored=JSON.parse(JSON.stringify(encoded));
    expect((await provider.send(request,context,{mode:"buffered",invocationId:"one",encodedInput:restored})).kind).toBe("succeeded");
    expect(sent).toEqual([encoded.body]);
    const changed=name==="ollama"?new OllamaProvider({...ollama,think:true},fetch):new OpenAICompatibleProvider({...openai,model:"changed-model"},fetch);
    expect((await changed.send(request,context,{mode:"buffered",invocationId:"changed",encodedInput:restored})).kind).toBe("failed");
    expect((await provider.send(request,context,{mode:"buffered",invocationId:"corrupt",encodedInput:{...restored,body:restored.body+" "}})).kind).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(encoded)).not.toContain("original-secret");
    if(name==="openai") {
      const rotated=new OpenAICompatibleProvider({...openai,apiKey:"replacement-secret",timeoutMs:9000},fetch);
      expect((await rotated.send(request,context,{mode:"buffered",invocationId:"rotated",encodedInput:restored})).kind).toBe("succeeded");
      expect(sent[1]).toBe(encoded.body);
    }
  });
  it("rechecks a stricter current transport limit without changing the accepted body",async()=>{
    let calls=0;const fetch:FetchLike=async()=>{calls++;throw new Error("should not dispatch");};
    const provider=new OllamaProvider(ollama,fetch),request=createNativeProviderRequest(provider),encoded=provider.encodeInput(request,"buffered");
    const limited=new OllamaProvider({...ollama,requestBodyTransportLimit:{...limit,maximumBytes:1}},fetch);
    expect(await limited.send(request,{signal:new AbortController().signal,interruption:null},{mode:"buffered",invocationId:"limited",encodedInput:encoded}))
      .toMatchObject({kind:"failed",failure:{code:"provider_transport_request_too_large"}});
    expect(calls).toBe(0);
  });
});
