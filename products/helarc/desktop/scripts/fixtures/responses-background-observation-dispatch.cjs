const assert=require("node:assert/strict"),{createHash}=require("node:crypto");
const base="https://api.openai.com/v1", endpoint=base+"/responses";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const terminal=new Set(["completed","incomplete","cancelled","failed"]);
function eligible(c,t){
  const n=c?.native;
  return c?.id===t.id && c.revision===t.revision && c.connectionBindingId===t.binding &&
    c.model===t.model && c.protocol==="openai.responses" && c.baseUrl===base && !c.archived && !c.isDefault &&
    n?.transport==="http" && n.background===true && n.allowTemporaryRetention===true && n.store===true &&
    !n.stream && n.continuity==="replay" && !n.allowConnectionMemory && !n.allowInRequestCompaction;
}
function backgroundObservationGuard(target,send,record,deadline){
  const counts={count:0,create:0,retrieve:0};let armed=false,halted=false,id=null,ended=false,pending=false;
  const stop=()=>{halted=true;};
  return {counts,arm(c){assert(!halted&&eligible(c,target));armed=true;},stop,
    async fetch(url,init){
      let operation,sha256=null,size=0;
      try{
        assert(armed&&!halted&&!pending&&Date.now()<deadline,"background-observation inactive or operation still pending");
        const address=String(url);
        if(init?.method==="GET"){
          assert(id&&!ended&&address===endpoint+"/"+encodeURIComponent(id)&&init.body==null&&counts.retrieve<10,"GET outside original observation scope");
          operation="retrieve";
        }else{
          assert.equal(init?.method,"POST");
          assert(counts.create===0,"a second create or post-create measurement is forbidden");
          assert(address===endpoint||address===endpoint+"/input_tokens","unexpected POST route");
          operation=address===endpoint?"create":"count";assert(counts[operation]<1,"POST budget exhausted");
          assert(typeof init.body==="string"||ArrayBuffer.isView(init.body));const bytes=typeof init.body==="string"?Buffer.from(init.body):
            Buffer.from(init.body.buffer,init.body.byteOffset,init.body.byteLength);
          size=bytes.length;assert(size<=131072);sha256=digest(bytes);const b=JSON.parse(bytes);
          assert(b.model===target.model&&Array.isArray(b.input)&&!b.previous_response_id&&!b.conversation&&!b.context_management);
          assert((b.tools??[]).every(t=>t.type==="function"),"unexpected server-side tool");
          if(operation==="create")assert(b.background===true&&b.store===true&&b.stream===false,"create not explicitly authorized background JSON");
        }
      }catch(err){stop();record({kind:"blocked",reason:err.message.split("\n")[0]});throw err;}
      const ordinal=++counts[operation];pending=true;
      record({kind:"dispatch",operation,ordinal,requested:operation==="retrieve"?id:null,sha256,size});
      try{
        const r=await send(url,{...init,redirect:"error",signal:AbortSignal.any([
          ...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,deadline-Date.now()))])});
        record({kind:"http",operation,ordinal,status:r.status});
        if(!r.ok){pending=false;if(operation!=="retrieve")stop();return r;}
        assert(r.body && r.headers.get("content-type")?.toLowerCase().includes("json"),"unexpected response framing");
        let length=0;const chunks=[];
        // Keep the original bytes and headers. Only a complete service reply can establish identity.
        const tap=new TransformStream({
          transform(chunk,ctl){length+=chunk.byteLength;if(length>1048576){stop();throw Error("background-observation witness size exceeded");}
            chunks.push(Buffer.from(chunk));ctl.enqueue(chunk);},
          flush(){try{
            const raw=Buffer.concat(chunks),obj=JSON.parse(raw.toString("utf8"));
            if(operation==="count"){assert(Number.isSafeInteger(obj.input_tokens));record({kind:"count-receipt",ordinal,tokens:obj.input_tokens});}
            else{
              assert(typeof obj.id==="string"&&/^resp_[A-Za-z0-9_-]+$/.test(obj.id),"invalid service response ID");
              record({kind:"observation",operation,ordinal,id:obj.id,status:obj.status,bodyDigest:digest(raw),usage:obj.usage??null});
              if(operation==="create")id=obj.id;else assert.equal(obj.id,id,"service returned another response");
              ended=terminal.has(obj.status);
              assert((obj.output??[]).every(i=>i.type!=="function_call"||i.name==="final_result"),"additional work outside single-create case");
            }
            pending=false;
          }catch(err){stop();throw err;}}
        });
        return new Response(r.body.pipeThrough(tap),{status:r.status,statusText:r.statusText,headers:r.headers});
      }catch(err){stop();record({kind:"unconfirmed",operation,ordinal});throw err;}
    }};
}
module.exports={backgroundObservationGuard,eligible,digest};
