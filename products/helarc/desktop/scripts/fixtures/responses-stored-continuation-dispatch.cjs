const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const base = "https://api.openai.com/v1";

function eligible(c, target) {
  return c?.id === target.id && c.revision === target.revision &&
    c.connectionBindingId === target.binding && c.model === target.model &&
    c.protocol === "openai.responses" && c.baseUrl === base && !c.archived && !c.isDefault &&
    c.native.transport === "http" && c.native.stream && c.native.store &&
    c.native.continuity === "stored-response" && !c.native.background && !c.native.allowInRequestCompaction;
}

// Observe the actual completed SSE event before allowing its ID in another request.
// Decode a side view of each chunk; forward the original bytes without re-encoding.
function witness(response, completed, failed) {
  assert(response.headers.get("content-type")?.includes("text/event-stream") && response.body);
  const decoder = new TextDecoder(); let pending = "", data = [], seen = false;
  function line(s) {
    if (s.endsWith("\r")) s = s.slice(0,-1);
    if (s.startsWith("data:")) { data.push(s.slice(5).trimStart()); return; }
    if (s || !data.length) return;
    const json = data.join("\n"); data = [];
    if (json === "[DONE]") return;
    const event = JSON.parse(json);
    if (event.type === "response.completed") {
      assert(!seen && event.response.status === "completed" && /^resp_/.test(event.response.id));
      completed(event.response); seen = true;
    }
  }
  const stream = new TransformStream({
    transform(chunk, ctl) {
      try {
        const lines = (pending + decoder.decode(chunk,{stream:true})).split("\n");
        pending = lines.pop(); for (const s of lines) line(s);
        ctl.enqueue(chunk);
      } catch (err) { failed(); throw err; }
    },
    flush() { const tail = pending + decoder.decode(); if(tail) line(tail); line(""); if(!seen) failed(); }
  });
  return new Response(response.body.pipeThrough(stream),{status:response.status,statusText:response.statusText,headers:response.headers});
}

function guard(target, send, record, deadline) {
  const counts = {generate:0,count:0}, ids = [];
  let armed = false, stopped = false;
  return {counts, arm(c){assert(eligible(c,target));armed=true;}, stop(){stopped=true;},
    async fetch(url,init) {
      const kind = String(url) === base+"/responses" ? "generate" : String(url) === base+"/responses/input_tokens" ? "count" : null;
      let bytes, body;
      try {
        assert(armed && !stopped && kind && Date.now()<deadline && counts[kind]<4,"dispatch outside stored-continuation budget");
        assert.equal(init?.method,"POST"); assert(typeof init.body==="string" || ArrayBuffer.isView(init.body));
        bytes = typeof init.body==="string"?Buffer.from(init.body):Buffer.from(init.body.buffer,init.body.byteOffset,init.body.byteLength);
        assert(bytes.length<=131072); body=JSON.parse(bytes);
        assert(body.model===target.model && Array.isArray(body.input) && !body.conversation && !body.background && !body.context_management);
        assert((body.tools??[]).every(t=>t.type==="function"));
        if(kind==="generate") assert(body.stream===true && body.store===true);
        assert.equal(ids.length,counts.generate,"prior create has no observed completion");
        assert.equal(body.previous_response_id??null,ids.at(-1)??null,"predecessor absent or not from this attempt");
      } catch(err) { stopped=true;record({kind:"blocked",operation:kind});throw err; }
      const index=++counts[kind];
      record({kind,index,digest:digest(bytes),bytes:bytes.length,previous:body.previous_response_id??null,
        items:body.input.map(i=>({type:i.type??"message",role:i.role,call:i.call_id}))});
      try {
        const res=await send(url,{...init,redirect:"error",signal:AbortSignal.any([
          ...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,deadline-Date.now()))])});
        record({kind:"receipt",operation:kind,index,status:res.status});
        if(!res.ok)stopped=true;
        return kind!=="generate"||!res.ok?res:witness(res, r=>{
          assert(!ids.includes(r.id));ids.push(r.id);
          record({kind:"remote-completed",index,response:r.id});
        },()=>{stopped=true;});
      } catch(err){stopped=true;record({kind:"unconfirmed",operation:kind,index});throw err;}
    }};
}
module.exports={eligible,guard,digest,witness};
