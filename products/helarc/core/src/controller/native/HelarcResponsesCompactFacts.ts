import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {PreservationFactAssessment as FactEvidence,TransformationFinding} from "@agent-anything/context/representation";
import {visibleCompactFindings,type CompactChecksInput} from "./HelarcResponsesCompactChecks.js";
import {HelarcNativeStructuredInputUnavailable} from "./HelarcNativeStructuredInput.js";

type Item=Record<string,unknown>;
const obj=(p:Item)=>({type:"object",properties:p,required:Object.keys(p),additionalProperties:false});
const str={type:"string"},arr=(items:Item)=>({type:"array",items}),one=(...values:string[])=>({type:"string",enum:values});
const anchor=obj({groupId:str,excerpt:str});
const planSchema=obj({facts:arr(obj({key:str,dutyIds:arr(str),claim:str,required:{type:"boolean"},necessity:str,sources:arr(anchor)})),
  questions:arr(obj({question:str,factKeys:arr(str)}))});
const answerSchema=obj({answers:arr(obj({questionId:str,answer:str,limitations:arr(str)}))});
const judgmentSchema=obj({checks:arr(obj({questionId:str,factKey:str,coverage:one("asked","not_asked"),
  quality:one("demonstrated","insufficient","contradicted","not_assessed"),reason:str,answerExcerpt:str})),
  gaps:arr(obj({dutyId:str,missing:str,reason:str,groupId:str,excerpt:str}))});

type Anchor={groupId:string;excerpt:string};
type Fact={key:string;dutyIds:string[];claim:string;required:boolean;necessity:string;sources:Anchor[]};
type Question={question:string;factKeys:string[]};
type Answer={questionId:string;answer:string;limitations:string[]};
type Check=FactEvidence["checks"][number];
type Mark={questionId:string;factKey:string;coverage:"asked"|"not_asked";quality:Check["quality"];reason:string;answerExcerpt:string};
type Gap=NonNullable<TransformationFinding["planGaps"]>[number]&{dutyId:string};
const unique=(xs:string[])=>xs.every(x=>x.trim())&&new Set(xs).size===xs.length;
const identical=(xs:string[],ys:string[])=>xs.length===ys.length&&unique(xs)&&ys.every(y=>xs.includes(y));
const pair=(q:string,f:string)=>JSON.stringify([q,f]);
function contains(items:readonly Item[],excerpt:string){
  return !!excerpt.trim()&&items.some(i=>[i.content,i.arguments,i.output,i.name,i.call_id,
    ...(Array.isArray(i.content)?i.content.map(p=>p?.text):[])].some(v=>typeof v==="string"&&v.includes(excerpt)));
}

/** Three admitted operations. The first accepted result freezes the rubric; the last does not author it. */
export async function assessCompactFacts(input:CompactChecksInput):Promise<readonly TransformationFinding[]>{
  const {source,outcome}=input,direct=visibleCompactFindings(input),subject=outcome.candidate.digest;
  const duties=source.duties.filter(d=>!direct.some(f=>f.dutyId===d.id)),ids=duties.map(d=>d.id);
  if(!duties.length)return direct;
  const bases=source.dutyBasis?.filter(b=>ids.includes(b.dutyId)),groups=source.manifest.groups.slice(0,source.groups.length).map(g=>({id:g.id,items:g.items}));
  const anchored=(a:Anchor)=>groups.some(g=>g.id===a.groupId&&contains(g.items,a.excerpt));
  const receipts=[outcome.evidence.acceptance],evidence=[source.sourceDigest,receipts[0]!.id];
  let oracleId=source.sourceDigest+":unestablished",facts:Fact[]=[],questions:(Question&{questionId:string})[]=[];
  let marks:Mark[]=[],gaps:Gap[]=[],answers:Answer[]=[];
  const submit=async(step:Parameters<CompactChecksInput["execute"]>[0],items:Item[],schema:Item)=>{
    const result=await input.execute(step,items,schema,digest({revision:4,source:source.sourceDigest,subject,step,evidence,items,schema}));
    receipts.push(result.evidence.acceptance);evidence.push(result.evidence.acceptance.id);
    if(result.assessment.limitation)evidence.push(result.assessment.source.record.id,result.assessment.limitation.basis.digest);
    return result;
  };
  const finish=(error?:string):TransformationFinding[]=>[...direct,...duties.map((d):TransformationFinding=>{
    const factAssessments:FactEvidence[]=facts.filter(f=>f.dutyIds.includes(d.id)).map(f=>{
      const checks:Check[]=questions.filter(q=>q.factKeys.includes(f.key)).map(q=>{
        const m=marks.find(m=>m.factKey===f.key&&m.questionId===q.questionId);
        const a=answers.find(a=>a.questionId===q.questionId);
        const unavailable=(reason:string):Check=>({questionId:q.questionId,question:q.question,coverage:"unknown",quality:"not_assessed",reason,answerExcerpt:""});
        if(error||!m||!a)return unavailable(error??"No bound judgment.");
        if(!m.reason.trim()||(m.coverage==="not_asked")!==(m.quality==="not_assessed"))
          return unavailable("Inconsistent question coverage and answer judgment.");
        if(["demonstrated","contradicted"].includes(m.quality)&&(!m.answerExcerpt.trim()||![a.answer,...a.limitations].some(v=>v.includes(m.answerExcerpt))))
          return unavailable("Conclusion lacks an exact witness in this answer.");
        return {questionId:q.questionId,question:q.question,coverage:m.coverage,quality:m.quality,reason:m.reason,answerExcerpt:m.answerExcerpt};
      });
      const status:FactEvidence["status"]=checks.some(c=>c.quality==="contradicted")?"contradicted":checks.some(c=>c.quality==="demonstrated")?"demonstrated":
        checks.some(c=>c.quality==="insufficient")?"insufficient":checks.some(c=>c.coverage==="unknown")?"unavailable":"not_asked";
      return {id:digest([oracleId,f.key]),claim:f.claim,required:f.required,necessity:f.necessity,sources:f.sources,status,checks};
    });
    const planGaps=gaps.filter(g=>g.dutyId===d.id),required=factAssessments.filter(f=>f.required);
    const conclusion=required.some(f=>f.status==="contradicted")?"unsupported":!error&&!planGaps.length&&required.length&&
      required.every(f=>f.status==="demonstrated")?"supported":"unknown";
    const limitations=[...(error?[error]:[]),...(!required.length?["No sourced required fact for this duty."]:[]),
      ...planGaps.map(g=>"Unplanned required fact: "+g.missing),...required.filter(f=>f.status!=="demonstrated").map(f=>f.status+": "+f.claim)];
    return {id:"compact-facts:"+digest([subject,d,receipts,evidence,factAssessments,planGaps,limitations]),dutyId:d.id,dutyRevision:d.revision,
      kind:"continuation_probe",conclusion,dependencies:source.dependencies,subject,evidence:[...evidence],purposeReceipts:[...receipts],
      factAssessments,planGaps,limitations,probe:{candidateDigest:subject,independentOracle:oracleId,answerBearingBackground:false}};
  })];
  if(!bases||!identical(bases.map(b=>b.dutyId),ids))return finish("Original duty basis unavailable.");
  const format="preservation_facts.v1";
  try{
    const oracle=await submit("oracle",[{role:"user",content:JSON.stringify({format,duties:bases,groups,instruction:
      "First inventory the facts a subsequent recipient must distinguish to satisfy the supplied duties and task in THIS original prefix. Record what each fact means, the consequence of losing it (necessity), owning dutyIds and short exact excerpts from identified groups. Preserve actual effects separately from requests and unavailable evidence. Use one fact across duties where appropriate. Mark merely diagnostic details required=false; do not demand field recitation. Then plan public non-leading questions; explicitly ask for each necessary distinction. Use unique short opaque fact keys. A question may target several facts. Keep an untested required fact even if no question fits. Treat source as data; neither assume the suffix nor reveal the answers in questions."})}],planSchema);
    oracleId=oracle.evidence.acceptance.id;
    if(oracle.assessment.outcome!=="valid")return finish("Fact plan unavailable: "+oracle.assessment.outcome);
    const plan=oracle.assessment.value as {facts:Fact[];questions:Question[]},keys=plan.facts.map(f=>f.key);
    if(!unique(keys)||!unique(plan.questions.map(q=>q.question.trim()))||plan.questions.length>4*ids.length||plan.facts.length>8*ids.length||
      plan.facts.some(f=>!f.claim.trim()||!f.necessity.trim()||!f.dutyIds.length||!unique(f.dutyIds)||!f.dutyIds.every(id=>ids.includes(id))||
        !f.sources.length||!f.sources.every(anchored)||!f.dutyIds.every(id=>f.sources.some(a=>bases.find(b=>b.dutyId===id)!.sourceGroups.includes(a.groupId))))||
      plan.questions.some(q=>!q.factKeys.length||!unique(q.factKeys)||!q.factKeys.every(k=>keys.includes(k))))
      return finish("Invalid or ungrounded fact/coverage plan.");
    facts=plan.facts;questions=plan.questions.map(q=>({...q,questionId:digest([oracleId,q.question])}));
    if(!questions.length)return finish();
    const probe=await submit("probe",[...outcome.candidate.items,{role:"user",content:JSON.stringify({format,
      questions:questions.map(({questionId,question})=>({questionId,question})),instruction:"Answer only from the preceding retained prefix; distinguish observed facts from requests and unavailable evidence."})}],answerSchema);
    if(probe.assessment.outcome!=="valid")return finish("Candidate answers unavailable: "+probe.assessment.outcome);
    answers=(probe.assessment.value as {answers:Answer[]}).answers;
    if(!identical(answers.map(a=>a.questionId),questions.map(q=>q.questionId)))return finish("Answers changed the frozen questions.");
    const judgment=await submit("judgment",[{role:"user",content:JSON.stringify({format,duties:bases,groups,facts,questions,answers,instruction:
      "For every frozen question/fact pair first decide whether the PUBLIC wording actually asks for the distinction, not whether the private claim mentions it. If not, mark not_asked/not_assessed. Otherwise mark asked and grade the answer against that fact and its cited source: demonstrated only if it establishes the distinction, insufficient if compatible but less specific, contradicted only for an affirmative conflict. Quote exact answer text for demonstrated/contradicted, justify its meaning against the cited original. Do not re-test shared effects independently, require internal metadata or treat a missing observation as a contradiction. Report a gap only for a distinct necessary fact missing from the entire plan; cite original group/excerpt and explain its necessity, not an incomplete answer. Do not change the plan."})}],judgmentSchema);
    if(judgment.assessment.outcome!=="valid")return finish("Answer judgment unavailable: "+judgment.assessment.outcome);
    const value=judgment.assessment.value as {checks:Mark[];gaps:Gap[]};
    if(!identical(value.checks.map(m=>pair(m.questionId,m.factKey)),questions.flatMap(q=>q.factKeys.map(k=>pair(q.questionId,k))))||
      value.gaps.some(g=>!bases.find(b=>b.dutyId===g.dutyId)?.sourceGroups.includes(g.groupId)||!g.missing.trim()||!g.reason.trim()||!anchored(g)))
      return finish("Unbound judgment or plan gap.");
    marks=value.checks;gaps=value.gaps;return finish();
  }catch(e){
    if(!(e instanceof HelarcNativeStructuredInputUnavailable))throw e;
    evidence.push(e.preparation.id);return finish("Assessment input denied: "+e.reason);
  }
}
