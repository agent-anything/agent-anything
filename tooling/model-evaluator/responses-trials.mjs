import { randomInt } from 'node:crypto';
import { request } from './connection.mjs';

const threshold = 13_500, arrangement = [{type:'compaction',compact_threshold:threshold}];
const tools = [{type:'function',name:'read_batch',description:'Read one immutable page of the synthetic production sensor inspection log. Pages 1 and 2 together form the complete inspection.',
  parameters:{type:'object',properties:{page:{type:'integer',enum:[1,2]}},required:['page'],additionalProperties:false},strict:true}];
const user = content => ({role:'user',content});
const intro = 'Audit all sensors in two inspection batches. First read page 1 with read_batch. Wait for the operator update before reading page 2. After both pages report only the sensor IDs that need a hold. We will ask about routing separately.';
const question = 'For each of these records, give the routing label in effect: a newly collected inspection and a retrospective recheck. Return only a JSON object with the keys new_inspection and retrospective_recheck.';
function correction(oracle) { return user('Operator correction: for newly collected inspections only, use routing label '+oracle.new_inspection+'. Retrospective rechecks still use the handbook label. This distinction must be available for the later routing decision. Now read page 2 and finish the hold list without restating the labels.'); }
function page(n,oracle) {
  const rows=[],start=(n-1)*295+1;
  for(let id=start;id<start+295;id++) {
    const values=Array.from({length:11},(_,i)=>String(100+(id*73+i*197+id*i)%900));
    if(id===68||id===527)values[6]='MISSING';
    rows.push([id,...values].join(','));
  }
  return (n===1?'Instrument handbook: the routing label '+oracle.retrospective_recheck+' applies to all inspection records unless an operator supersedes it.\n':'')+
    'Page '+n+' of 2. CSV columns: sensor_id,channel_1,...,channel_11. MISSING means hold that sensor.\n'+rows.join('\n');
}
function visible(model,input) { return {model,input,tools,tool_choice:'auto',parallel_tool_calls:true}; }
function generation(model,input,arrange) {
  return {...visible(model,input),store:false,stream:true,include:['reasoning.encrypted_content'],max_output_tokens:1800,
    ...(arrange?{context_management:arrangement}:{})};
}
const countRoute='/responses/input_tokens', generateRoute='/responses';
function countOf(r) {
  if(r.httpStatus!==200)return null;
  const v=JSON.parse(r.raw);
  return v.object==='response.input_tokens'&&Number.isSafeInteger(v.input_tokens)&&v.input_tokens>=0?v.input_tokens:null;
}
function end(trial,status,category,reason){Object.assign(trial,{status,category,reason});}

// A successful count is a wire observation, not evidence of the counter's rendering semantics.
export async function probeResponsesCount(control,trial,send) {
  const baseline=countOf(await send('control',countRoute,control));
  trial.assessments.push({phase:'count_control',tokens:baseline});
  if(baseline===null)return end(trial,'inconclusive','control_unavailable','No valid control count for this tool history.');
  const result=await send('with_setting',countRoute,{...control,context_management:arrangement});
  let error;try{error=JSON.parse(result.raw)?.error;}catch{}
  const count=countOf(result);
  trial.assessments.push({phase:'count_with_setting',httpStatus:result.httpStatus,tokens:count,errorCode:error?.code,parameter:error?.param,
    completeInitialRendering:'not_established'});
  trial.observations.push('Initial rendering equivalence and any hard-budget admission remain unknown.');
  if(count!==null)return end(trial,'passed','count_returned','The counter returned '+count+' with the field, versus '+baseline+' without. Field semantics are not established.');
  if(result.httpStatus===400&&error?.code==='unknown_parameter'&&error?.param==='context_management')
    return end(trial,'failed','count_field_rejected','The count endpoint explicitly rejected context_management; this is not a model quality failure.');
  end(trial,'inconclusive','count_response_unclassified','No valid count or field-specific rejection.');
}

function readStream(http) {
  if(http.httpStatus!==200)throw Error('Responses generation returned HTTP '+http.httpStatus+'.');
  let response, responseId, seq=-1;const done=new Map();
  for(const block of http.raw.replace(/\r\n?/g,'\n').split(/\n\n+/)){
    const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');
    if(!data||data==='[DONE]')continue;
    const e=JSON.parse(data);
    if(response||e.type==='error'||(e.sequence_number!==undefined&&(!Number.isSafeInteger(e.sequence_number)||e.sequence_number<=seq)))
      throw Error('Invalid or interrupted Responses stream.');
    seq=e.sequence_number??seq;
    if(e.response){if(!e.response.id||(responseId&&responseId!==e.response.id))throw Error('Response identity changed.');responseId=e.response.id;}
    if(e.type==='response.output_item.done'&&e.item?.type==='compaction')done.set(e.output_index,e.item);
    if(['response.completed','response.failed','response.incomplete'].includes(e.type)){
      if(e.response?.status!==e.type.slice(9))throw Error('Conflicting terminal response.');
      response=e.response;
    }
  }
  if(response?.object!=='response'||response.status!=='completed'||response.error||response.incomplete_details||!Array.isArray(response.output))
    throw Error('No completed native response; retention is not graded.');
  return {response,done};
}
function replayItems(response) {
  return response.output.map(item=>{
    if(!item.id||!['message','function_call','reasoning','compaction','configuration_update'].includes(item.type)||
      (item.status!==undefined&&item.status!=='completed'))throw Error('Unsupported or unfinished replay item.');
    const {created_by,parsed_arguments,...copy}=item;
    if(item.type==='message')copy.content=item.content.map(({parsed,...part})=>part);
    return copy;
  });
}
function collectItems(trial,phase,observation) {
  const {response,done}=observation,items=replayItems(response),indices=[];
  items.forEach((item,i)=>{
    if(item.type==='compaction'){
      if(!item.encrypted_content||done.get(i)?.id!==item.id||done.get(i)?.encrypted_content!==item.encrypted_content)
        throw Error('Compaction is not corroborated by the stream and terminal output.');
      indices.push(i);
    }
  });
  if(indices.length!==done.size)throw Error('Inconsistent compaction observations.');
  trial.assessments.push({phase,responseId:response.id,reportedModel:response.model,usage:response.usage,
    output:items.map(i=>i.type),compactions:indices.map(i=>({index:i,id:items[i].id}))});
  return {items,indices};
}
export async function evaluateResponsesTrial(config,id,trial,signal,options={}) {
  const oracle=options.oracle??{new_inspection:'TULIP-'+randomInt(100,1000),retrospective_recheck:'MICA-'+randomInt(100,1000)};
  const wire=options.wire??((route,body)=>request(config,route,body,signal,true));
  trial.observations=[];
  const send=async(phase,route,body)=>{
    signal.throwIfAborted();
    if(Buffer.byteLength(JSON.stringify(body))>192*1024)throw Error('Request exceeds the experiment byte limit.');
    const e={phase,route,requestedAt:new Date().toISOString(),request:body,response:null};trial.evidence.push(e);
    const start=performance.now();
    try{return e.response=await wire(route,body,phase);}finally{e.elapsedMs=Math.round(performance.now()-start);}
  };
  if(id==='responses-count-field'){
    // Synthetic tool history; counting must never initiate a generation.
    const call=n=>({type:'function_call',name:'read_batch',call_id:'call_'+n,arguments:JSON.stringify({page:n})});
    const result=n=>({type:'function_call_output',call_id:'call_'+n,output:page(n,oracle)});
    return probeResponsesCount(visible(config.model,[user(intro),call(1),result(1),correction(oracle),call(2),result(2)]),trial,send);
  }
  if(id!=='responses-compaction-use')throw Error('Unknown native Responses probe.');
  trial.oracle=oracle;
  trial.observations.push('Only this sample is graded; complete input coverage and product admission are not evaluated.');
  let input=[user(intro)];const calls=new Set();
  async function turn(phase,body){return collectItems(trial,phase,readStream(await send(phase,generateRoute,body)));}
  for(const n of [1,2]){
    const {items,indices}=await turn('read_'+n,generation(config.model,input,true));
    if(indices.length)return end(trial,'inconclusive','unexpected_early_compaction','Compaction occurred before the intended comparison.');
    const requests=items.filter(i=>i.type==='function_call'),call=requests[0];
    let args;try{args=JSON.parse(call?.arguments);}catch{}
    if(requests.length!==1||call.name!=='read_batch'||!call.call_id||calls.has(call.call_id)||args?.page!==n||Object.keys(args).length!==1)
      return end(trial,'inconclusive','history_not_formed','The expected single read was not requested. No unrequested or duplicate read was executed.');
    calls.add(call.call_id);input.push(...items,{type:'function_call_output',call_id:call.call_id,output:page(n,oracle)});
    if(n===1)input.push(correction(oracle));
  }
  const tokens=countOf(await send('visible_count',countRoute,visible(config.model,input)));
  trial.assessments.push({phase:'visible_count',tokens,threshold,coverage:'visible fields only'});
  if(tokens===null||tokens<=threshold||tokens>16384)return end(trial,'inconclusive','outside_sample_range','Visible input did not fall in the planned range; no larger input is attempted.');
  const {items,indices}=await turn('crossing',generation(config.model,input,true));
  if(!indices.length)return end(trial,'inconclusive','no_new_item','No new compaction item was observed; subsequent use was not tested.');
  const index=indices.at(-1),suffix=items.slice(index);
  trial.observations.push('A new compaction item was observed in this response.');
  if(items.some(i=>i.type==='function_call'))return end(trial,'inconclusive','additional_work','Unexpected tool request; no additional work executed.');
  const follow=generation(config.model,[...suffix,user(question)],false);
  const clear=JSON.stringify(follow,(k,v)=>k==='encrypted_content'?'':v).toUpperCase();
  const leak=Object.values(oracle).some(v=>clear.includes(v.toUpperCase()));
  trial.assessments.push({phase:'reduced_replay',itemId:suffix[0].id,omittedItems:input.length+index,plaintextLabelsPresent:leak,
    otherOpaque:suffix.slice(1).some(i=>i.encrypted_content!==undefined)});
  if(leak||suffix.slice(1).some(i=>i.encrypted_content!==undefined))return end(trial,'inconclusive','not_isolated','Other retained material could supply the labels; no blind grade.');
  const last=await turn('blind_use',follow);
  if(last.indices.length||last.items.some(i=>i.type==='function_call'))return end(trial,'inconclusive','unexpected_followup','The follow-up did not produce an isolated answer.');
  let answer;try{answer=JSON.parse(last.items.flatMap(i=>i.type==='message'?i.content.filter(p=>p.type==='output_text').map(p=>p.text):[]).join('\n'));}catch{}
  if(typeof answer?.new_inspection!=='string'||typeof answer?.retrospective_recheck!=='string')
    return end(trial,'inconclusive','ungradable_answer','The blind answer could not be compared by scope.');
  const matches=Object.fromEntries(Object.entries(oracle).map(([k,v])=>[k,answer[k]===v]));
  trial.assessments.push({phase:'blind_answer',answer,matches});
  const correct=Object.values(matches).every(Boolean);
  end(trial,correct?'passed':'failed',correct?'sample_retained':'incorrect_scoped_answer',
    correct?'Both labels were correct for their respective scopes from reduced replay.':'The answer assigned an incorrect label to at least one scope.');
}
