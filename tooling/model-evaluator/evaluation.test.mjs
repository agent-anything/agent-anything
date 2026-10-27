import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Evaluation } from './evaluation.mjs';
import { configuration, discover, encode } from './connection.mjs';
import { startServer } from './server.mjs';

export async function fakeProvider(mode = 'normal') {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ models: [{name:'fixture'}],data:[{id:'fixture'}] })); return; }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
    if(mode==='hang')return;
    if(mode==='error'){res.writeHead(500);res.end('test-secret');return;}
    const last=body.messages.at(-1), first=body.messages[0].content;
    let content='', calls=[];
    const call = key => ({id:`call-${calls.length}`, type:'function',function:{name:'lookup_record',arguments:JSON.stringify({key})}});
    if(last.role==='tool') {const result=JSON.parse(last.content);if(result.error)calls.push(call(result.requiredKey));else content=result.value;}
    else if(first.startsWith('Reply'))content=first.match(/exactly ([^,]+)/)[1];
    else if(first.startsWith('Return'))content=JSON.stringify({marker:first.match(/must be "([^"]+)"/)[1],count:3});
    else if(first.startsWith('Call')){const marker=first.match(/key "([^"]+)" and once for "([^"]+)"/);calls.push(call(marker[1]),call(marker[2]));}
    else calls.push(call(first.match(/key "([^"]+)"/)[1]));
    if(mode==='fail') {content='wrong';calls=[];}
    const message={role:'assistant',content,...(calls.length?{tool_calls:calls}: {})};
    const ollama=req.url==='/api/chat';
    if(ollama&&message.tool_calls)message.tool_calls=message.tool_calls.map(c=>({function:{...c.function,arguments:JSON.parse(c.function.arguments)}}));
    res.setHeader('content-type','application/json');res.end(JSON.stringify(ollama?
      {message,done:true,done_reason:mode==='length'?'length':'stop'}:
      {choices:[{message,finish_reason:mode==='length'?'length':calls.length?'tool_calls':'stop'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,requests,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
async function fixture(t, mode) {
  const provider=await fakeProvider(mode),directory=await mkdtemp(join(tmpdir(),'model-evaluator-'));
  const evaluator=new Evaluation(directory);await evaluator.initialize();
  t.after(async()=>{await evaluator.close();await provider.close();await rm(directory,{recursive:true,force:true});});
  return {provider,directory,evaluator,config:configuration({kind:'ollama',baseUrl:provider.url,model:'fixture',apiKey:'test-secret',repetitions:1})};
}

for(const kind of ['ollama','openai-compatible'])test(`${kind}: evidence and ordered tool-result interactions survive restart`,async t=>{
  const f=await fixture(t),config={...f.config,kind,parameters:kind==='ollama'?{think:false,num_ctx:32768}:{thinking:{type:'disabled'}}};
  assert.deepEqual(await discover(config),['fixture']);
  const id=await f.evaluator.start(config);await f.evaluator.active.work;
  const report=f.evaluator.reports.get(id);assert.equal(report.status,'completed');assert.equal(report.trials.length,6);
  assert.deepEqual(report.trials.map(t=>t.status),Array(6).fill('passed'));
  for(const trial of report.trials.filter(t=>t.evidence.length===2)) {
    const messages=trial.evidence[1].request.messages;assert.deepEqual(messages.map(m=>m.role),['user','assistant','tool']);
    if(kind==='openai-compatible')assert.equal(messages[2].tool_call_id,messages[1].tool_calls[0].id);
    else assert.equal(messages[2].tool_name,'lookup_record');
  }
  const text=await readFile(join(f.directory,`${id}.json`),'utf8');assert.ok(!text.includes('test-secret'));
  const reopened=new Evaluation(f.directory);await reopened.initialize();assert.deepEqual(reopened.reports.get(id),report);
  assert.equal(f.provider.requests.length,8);
});
test('failure, truncation and connection errors have distinct outcomes',async t=>{
  for(const [mode,outcome] of [['fail','failed'],['length','inconclusive'],['error','inconclusive']]) {
    const f=await fixture(t,mode),id=await f.evaluator.start(f.config);await f.evaluator.active.work;
    const report=f.evaluator.reports.get(id);assert.ok(report.trials.every(t=>t.status===outcome));
    assert.ok(!JSON.stringify(report).includes('test-secret'));
  }
});
test('cancellation releases the active evaluation; interrupted reports stay truthful',async t=>{
  const f=await fixture(t,'hang'),id=await f.evaluator.start(f.config),work=f.evaluator.active.work;
  await new Promise(resolve=>setTimeout(resolve,40));f.evaluator.cancel(id);await work;
  assert.equal(f.evaluator.active,null);assert.equal(f.evaluator.reports.get(id).status,'cancelled');
  const report=f.evaluator.reports.get(id);report.status='running';await f.evaluator.save(report);
  const next=new Evaluation(f.directory);await next.initialize();assert.equal(next.reports.get(id).status,'interrupted');
  await next.delete(id);assert.equal(next.reports.size,0);
});
test('configuration and transport do not accept arbitrary request overrides',()=>{
  assert.throws(()=>configuration({kind:'ollama',baseUrl:'http://remote.invalid'}));
  assert.throws(()=>configuration({kind:'ollama',baseUrl:'http://localhost',parameters:{messages:[]}}));
  assert.throws(()=>configuration({kind:'ollama',baseUrl:'http://localhost',repetitions:100}));
  const c=configuration({kind:'openai-compatible',baseUrl:'https://example.invalid/v1',parameters:{reasoning_effort:'high'}});
  assert.equal(encode(c,[],[]).reasoning_effort,'high');assert.equal(encode(c,[],[]).max_tokens,undefined);
});
test('independent entry requires local token; no Helarc state or adoption endpoint',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'model-evaluator-http-')),app=await startServer({port:0,directory});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  assert.equal((await fetch(`${app.url}/api/reports`)).status,401);
  const headers={authorization:`Bearer ${app.token}`};
  assert.deepEqual(await (await fetch(`${app.url}/api/reports`,{headers})).json(),[]);
  assert.equal((await fetch(`${app.url}/api/reports`,{headers:{...headers,origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(`${app.url}/api/publish`,{method:'POST',headers,body:'{}'})).status,404);
  assert.match(await (await fetch(app.url)).text(),/Model Evaluator/);
});
test('unrecognized retained reports are rejected instead of erased',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'model-evaluator-corrupt-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'00000000-0000-0000-0000-000000000000.json');await writeFile(path,'{}');
  await assert.rejects(new Evaluation(directory).initialize());assert.equal(await readFile(path,'utf8'),'{}');
});
