import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuration} from './connection.mjs';
import {selectedCases} from './cases.mjs';
import {Evaluation} from './evaluation.mjs';
import {evaluateResponsesTrial} from './responses-trials.mjs';

const countId='responses-count-field',useId='responses-compaction-use',oracle={new_inspection:'NEW-134',retrospective_recheck:'OLD-681'};
const opts={kind:'openai-responses',model:'fixture',baseUrl:'http://localhost',suite:countId,repetitions:1};
const response=(status,value)=>({httpStatus:status,raw:JSON.stringify(value)});
const count=response(200,{object:'response.input_tokens',input_tokens:14481});
const trial=()=>({evidence:[],assessments:[],status:'inconclusive'});
function stream(items,omitDone=false){
  const events=items.flatMap((item,i)=>omitDone?[]:[{type:'response.output_item.done',output_index:i,item}]);
  events.push({type:'response.completed',response:{object:'response',id:'resp',model:'fixture',status:'completed',output:items}});
  return {httpStatus:200,raw:events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')};
}
test('native probes cannot enter chat suites or run repeated attempts by accident',()=>{
  assert(selectedCases('all').every(c=>!c.id.startsWith('responses-')));
  for(const patch of [{kind:'ollama'},{suite:'all'},{repetitions:2},{parameters:{context_management:[]}}])
    assert.throws(()=>configuration({...opts,...patch}));
});
test('field rejection is isolated, retained, and not published as a model grade',async t=>{
  const sent=[];
  const s=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    assert.equal(req.url,'/responses/input_tokens');
    const body=JSON.parse(Buffer.concat(chunks));sent.push(body);
    const r=sent.length===1?count:response(400,{error:{code:'unknown_parameter',param:'context_management'}});
    res.writeHead(r.httpStatus);res.end(r.raw);
  });
  await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  const dir=await mkdtemp(join(tmpdir(),'native-eval-')),e=new Evaluation(dir);
  t.after(async()=>{await e.close();s.closeAllConnections();await new Promise(r=>s.close(r));await rm(dir,{recursive:true,force:true});});
  await e.initialize();const id=await e.start(configuration({...opts,baseUrl:'http://127.0.0.1:'+s.address().port,apiKey:'private-test-value'}));
  await e.active.work;assert.equal(sent.length,2);
  const {context_management,...rest}=sent[1];assert.deepEqual(rest,sent[0]);assert.deepEqual(context_management,[{type:'compaction',compact_threshold:13500}]);
  const reopened=new Evaluation(dir);await reopened.initialize();const [r]=reopened.reports.get(id).trials;
  assert.equal(r.category,'count_field_rejected');assert.equal(r.assessments[1].completeInitialRendering,'not_established');
  assert(!(await readFile(join(dir,id+'.json'),'utf8')).includes('private-test-value'));
});
test('a count number is not rendering coverage, and unrelated errors are inconclusive',async()=>{
  for(const [result,category] of [[count,'count_returned'],[response(401,{error:{code:'invalid_api_key'}}),'count_response_unclassified'],
    [response(400,{error:{code:'unknown_parameter',param:'tools'}}),'count_response_unclassified']]){
    const t=trial();await evaluateResponsesTrial(opts,countId,t,new AbortController().signal,{wire:async(_,__,phase)=>phase==='control'?count:result});
    assert.equal(t.category,category);assert.equal(t.assessments[1].completeInitialRendering,'not_established');
  }
});
async function replay(mode,t){
  let uses=0;
  await evaluateResponsesTrial(opts,useId,t,new AbortController().signal,{oracle,wire:async(route,body,phase)=>{
    if(phase==='visible_count'){assert.equal(route,'/responses/input_tokens');return count;}
    assert.equal(route,'/responses');assert.equal(body.store,false);assert(!body.previous_response_id);
    const msg=(text)=>({id:'m',type:'message',role:'assistant',content:[{type:'output_text',text}]});
    if(phase.startsWith('read_')){
      const page=Number(phase.at(-1));return stream([{id:'f'+page,type:'function_call',name:'read_batch',call_id:'call_'+page,arguments:JSON.stringify({page})}]);
    }
    if(phase==='crossing'){
      assert.equal(body.input.filter(i=>i.type==='function_call_output').length,2);
      const compact={id:'cmp',type:'compaction',encrypted_content:'opaque'};
      return stream([...(mode==='no_item'?[]:[compact]),msg(mode==='leak'?oracle.new_inspection:'68, 527')],mode==='no_done');
    }
    assert.equal(phase,'blind_use');uses++;assert.equal(body.input[0].id,'cmp');assert.equal(body.input.length,3);assert(!JSON.stringify(body).includes(oracle.new_inspection));
    return stream([msg(JSON.stringify(mode==='wrong'?{...oracle,new_inspection:oracle.retrospective_recheck}:oracle))]);
  }});return uses;
}
test('requires a new, corroborated item, isolated replay and both correctly scoped labels',async()=>{
  for(const [mode,status,category,probes] of [['ok','passed','sample_retained',1],['wrong','failed','incorrect_scoped_answer',1],
    ['leak','inconclusive','not_isolated',0],['no_item','inconclusive','no_new_item',0]]){
    const t=trial();assert.equal(await replay(mode,t),probes);assert.equal(t.status,status);assert.equal(t.category,category);
  }
  const t=trial();await assert.rejects(replay('no_done',t),/corroborated/);assert(!t.evidence.some(e=>e.phase==='blind_use'));
});
