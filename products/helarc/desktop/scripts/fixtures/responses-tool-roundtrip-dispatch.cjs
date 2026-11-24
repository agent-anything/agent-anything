const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function replayGuard(maximum, target, send, record, deadline, hasExpectedValue = () => false, witness, beforeSend) {
  const counts = {generate:0, count:0};
  let stopped = false, enabled = false, awaitingCompletion = false;
  function eligible(c) {
    return c.id === target.id && c.revision === target.revision && c.connectionBindingId === target.binding &&
      c.model === target.model && c.protocol === "openai.responses" && c.baseUrl === "https://api.openai.com/v1" &&
      !c.archived && c.native.transport === "http" && c.native.stream && !c.native.store && !c.native.background &&
      c.native.continuity === "replay" && !c.native.allowInRequestCompaction;
  }
  return {counts, eligible, arm(c) { assert(eligible(c)); enabled = true; }, stop() { stopped = true; },
    async fetch(url, init) {
      const address = String(url);
      const kind = address === "https://api.openai.com/v1/responses" ? "generate"
        : address === "https://api.openai.com/v1/responses/input_tokens" ? "count" : null;
      let body, bytes;
      try {
        assert(enabled && !stopped && !awaitingCompletion && Date.now() < deadline && kind && counts[kind] < maximum, "dispatch scope or budget");
        assert.equal(init?.method, "POST");
        assert(typeof init.body === "string" || ArrayBuffer.isView(init.body), "unsupported request body");
        bytes = typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body.buffer,init.body.byteOffset,init.body.byteLength);
        assert(bytes.length <= 131072, "input byte budget");
        body = JSON.parse(bytes.toString("utf8"));
        assert(body.model === target.model && Array.isArray(body.input) && !body.previous_response_id && !body.conversation &&
          !body.context_management && !body.background && !body.store, "model or native mode differs");
        assert((body.tools ?? []).every(t => t.type === "function"), "server-side tool outside this case");
        if (kind === "generate") assert(body.store === false && body.stream === true, "foreground non-stored SSE required");
        beforeSend?.(body,counts.generate);
      } catch (error) { stopped = true; record({kind:"dispatch_blocked",reason:error.message}); throw error; }
      const index = ++counts[kind];
      if(witness && kind==="generate")awaitingCompletion=true;
      record({kind,index,sha256:digest(bytes),bytes:bytes.length,input:body.input.map(i=>({
        type:i.type??"message",role:i.role,callId:i.call_id,name:i.name,hasExpectedValue:hasExpectedValue(i)
      })),toolNames:(body.tools??[]).map(t=>t.name)});
      let response;
      try { response = await send(url,{...init,redirect:"error",signal:AbortSignal.any([
        ...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,deadline-Date.now()))])}); }
      catch(error) { stopped=true;record({kind:"transport_outcome_unknown",operation:kind,index});throw error; }
      record({kind:"response",operation:kind,index,status:response.status,requestId:response.headers.get("x-request-id")});
      // Do not retry a real rejection to see whether a different answer emerges.
      if (!response.ok) stopped = true;
      if(witness && kind==="generate" && response.ok)return witness(response,r=>{
        awaitingCompletion=false;record({kind:"completed",index,response:r.id});
      },()=>{stopped=true;});
      return response;
    }};
}
const toolRoundtripGuard=(...args)=>replayGuard(4,...args);
const delegatedMaterialGuard=(target,send,record,deadline,marker)=>replayGuard(8,target,send,record,deadline,marker,require("./responses-stored-continuation-dispatch.cjs").witness);
function delegatedDateGuard(target,send,record,deadline,marker,readRef) {
  const witness=require("./responses-stored-continuation-dispatch.cjs").witness;
  let readId;
  return replayGuard(2,target,send,record,deadline,marker,(response,complete,fail)=>witness(response,r=>{
    const calls=r.output.filter(i=>i.type==="function_call");
    for(const call of calls) {
      if(call.name==="final_result")continue;
      const ref=JSON.parse(call.arguments).reference, original=readRef();
      assert(!readId && calls.length===1 && /^ContextMaterialRead(?:_|$)/.test(call.name) &&
        ref?.id===original?.id && ref?.revision===original?.revision,"outside date-only follow-up");
      readId=call.call_id;
    }
    complete(r);
  },fail),(body,generations)=>{
    const matches=body.input.filter(marker);
    if(!generations)assert.equal(matches.length,0,"answer already in initial input");
    else assert(readId && matches.length===1 && matches[0].type==="function_call_output" && matches[0].call_id===readId,
      "date statement not supplied by the new authorized read");
  });
}
module.exports = {toolRoundtripGuard,delegatedMaterialGuard,delegatedDateGuard,digest};
