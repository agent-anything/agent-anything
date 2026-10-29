const $ = selector => document.querySelector(selector);
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has('token')) { sessionStorage.setItem('evaluatorToken', hash.get('token')); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem('evaluatorToken') ?? '';
let active = null, selected = null, busy = false, latest = null;
let catalog = null;
const form = $('#connection');
async function api(route, input) {
  const response = await fetch(`/api/${route}`, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(input ? {'content-type':'application/json'} : {}) }, body: input ? JSON.stringify(input) : undefined });
  const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
}
function config() { const d = form.elements; return { kind:d.kind.value, baseUrl:d.baseUrl.value, apiKey:d.apiKey.value, model:d.model.value,
  timeoutMs:Number(d.timeout.value)*1000, repetitions:Number(d.repetitions.value), parameters:JSON.parse(d.parameters.value), suite:d.suite.value }; }
function node(tag, text, parent) { const el=document.createElement(tag); if(text!==undefined)el.textContent=text; if(parent)parent.append(el);return el; }
function button(text, parent, action) { const el=node('button',text,parent);el.type='button';el.addEventListener('click',()=>void perform(action));return el; }
function lock() { for(const el of form.elements)el.disabled=!!active||busy; $('#cancel').disabled=!active; }
async function perform(action) { if(busy)return;busy=true;lock();$('#error').textContent='';try{await action();await refresh();}catch(e){$('#error').textContent=e.message;}finally{busy=false;lock();} }
form.addEventListener('submit',e=>{e.preventDefault();void perform(async()=>{selected=(await api('start',config())).id;});});
$('#discover').addEventListener('click',()=>void perform(async()=>{const models=await api('models',config());$('#models').replaceChildren();for(const id of models){const el=node('option',undefined,$('#models'));el.value=id;}if(!form.elements.model.value&&models.length)form.elements.model.value=models[0];}));
$('#cancel').addEventListener('click',()=>void perform(()=>api('cancel',{id:active})));
form.elements.kind.addEventListener('change',()=>{form.elements.baseUrl.value=form.elements.kind.value==='ollama'?'http://localhost:11434':'https://api.openai.com/v1';form.elements.model.value='';form.elements.parameters.value='{}';form.elements.apiKey.value='';$('#models').replaceChildren();});
function coverage(){const ids=catalog?.suites.find(s=>s.id===form.elements.suite.value)?.cases??[];$('#coverage').replaceChildren();for(const c of catalog?.cases??[])if(ids.includes(c.id))node('li',c.title,$('#coverage'));}
form.elements.suite.addEventListener('change',coverage);

async function refresh() {
  if(!catalog){catalog=await api('cases');form.elements.suite.replaceChildren();for(const s of catalog.suites){const option=node('option',s.title,form.elements.suite);option.value=s.id;}coverage();}
  const reports=await api('reports');active=reports.find(r=>r.status==='running')?.id??null;
  $('#status').textContent=active?'Evaluating':'Idle';lock();
  const container=$('#history'); container.replaceChildren();
  if(!reports.length)node('p','No evaluations yet.',container);
  for(const r of reports){const row=node('div',undefined,container);row.className='history-row';
    const open=button(`${r.target.model} | ${r.status} | ${r.trials.length}/${r.total}`,row,async()=>{selected=r.id;latest=null;});open.className=r.id===selected?'selected':'';
    node('time',new Date(r.startedAt).toLocaleString(),row);
  }
  selected??=reports[0]?.id??null;
  if(selected){const report=await api(`report/${selected}`);const signature=JSON.stringify(report);
    if(signature!==latest){const opened=new Set([...$('#report').querySelectorAll('details[open]')].map(e=>e.dataset.key));render(report,opened);latest=signature;}}
}
function render(r,opened) {
  const view=$('#report');view.hidden=false;view.replaceChildren();node('h2',r.target.model,view);
  node('p',`${r.trials.filter(t=>t.status==='passed').length} passed | ${r.trials.filter(t=>t.status==='failed').length} failed | ${r.trials.filter(t=>t.status==='inconclusive').length} inconclusive`,view);
  for(const s of r.summary??[]){const section=node('section',undefined,view);section.className='dimension-summary';node('h3',({generation:'Generation',checking:'Checking','repeated-transformation':'Repeated transformation',baseline:'Basic capabilities'})[s.dimension]??s.dimension,section);
    node('p',`${s.passed}/${s.trials} passed | ${s.failed} failed | ${s.inconclusive} inconclusive | ${s.invalidStructure} invalid structure | ${s.diagnosticOnlyTrials??0} content-only diagnostics (not passes)`,section);
    if(s.dimension==='checking')node('p',`Graded candidates: ${s.gradedFaultyCandidates}/${s.faultyCandidates} faulty, ${s.gradedFaithfulCandidates}/${s.faithfulCandidates} faithful | False acceptance: ${s.falseAcceptance} | False rejection (any requirement): ${s.falseRejection} | Unknown judgments: ${s.unknownJudgments}`,section);}
  const actions=node('div',undefined,view);actions.className='actions';
  button('Download report',actions,async()=>{const blob=new Blob([JSON.stringify(r,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);const a=node('a');a.href=url;a.download=`evaluation-${r.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  const del=button('Delete',actions,async()=>{if(!confirm('Delete this evaluation and its evidence?'))return;await api('delete',{id:r.id});selected=null;latest=null;view.hidden=true;});del.disabled=r.status==='running';
  if(r.error)node('p',r.error,view).className='error';
  const info=node('details',undefined,view);info.dataset.key='target';info.open=opened.has('target');node('summary','Configuration and limitations',info);node('pre',JSON.stringify({target:r.target,suite:r.suiteRevision,limitations:r.limitations},null,2),info);
  for(const [i,t] of r.trials.entries()){const details=node('details',undefined,view);details.dataset.key=String(i);details.open=opened.has(String(i));details.className=`trial ${t.status}`;
    node('summary',`${t.title} | Trial ${t.repetition} | ${t.status}`,details);if(t.reason)node('p',`${t.category??''}: ${t.reason}`,details);
    if(t.assessments?.length){node('h3','Independent checks',details);node('pre',JSON.stringify(t.assessments,null,2),details);}
    if(t.oracle){node('h3','Expected facts (not sent to model)',details);node('pre',JSON.stringify(t.oracle,null,2),details);}
    node('h3','Actual requests and responses',details);node('pre',JSON.stringify(t.evidence,null,2),details);}
}
async function poll(){try{await refresh();}catch(e){$('#error').textContent=e.message;}setTimeout(poll,1500);}
void poll();
