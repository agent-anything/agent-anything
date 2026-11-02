const answerDomains={image5:value=>typeof value==="number"&&Number.isFinite(value),image6:value=>typeof value==="number"&&Number.isFinite(value),
  alpha:value=>["preserved","changed"].includes(value),version:value=>["verified","unverified"].includes(value)};
export function assessSubsequentUse(text,expected){
  if(typeof text!=="string")return {verdict:"insufficient_evidence",explanation:"No accepted subsequent response"};
  let answer;try{answer=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));}catch{return {verdict:"insufficient_evidence",explanation:"Response has no unambiguous structured answer; manual review required"};}
  const keys=Object.keys(expected);
  if(!keys.length||keys.some(key=>!answerDomains[key]?.(expected[key])))throw new Error("Unsupported independent answer domain");
  const known=key=>answer!==null&&typeof answer==="object"&&!Array.isArray(answer)&&Object.hasOwn(answer,key)&&answerDomains[key](answer[key]);
  if(keys.some(key=>known(key)&&answer[key]!==expected[key]))return {verdict:"violated",explanation:"At least one explicit answer field contradicts an independent source fact; other missing fields do not remove that contradiction"};
  if(keys.some(key=>!known(key)))return {verdict:"insufficient_evidence",explanation:"Required answer fields are missing or outside the declared comparison domain; manual review required"};
  return {verdict:"conforms",explanation:"Accepted answer fields compared with independent source-author facts; formatting and extra prose fields are not compared"};
}

export function assessCapturedSubsequentUse(evidence,plan){
  const heldout=plan.trial.caseRef.id==="scoped-correction-heldout";
  const output=evidence?.snapshot?.outcome.use?.response?.output??(typeof evidence?.taskOutput==="string"?evidence.taskOutput:evidence?.taskOutput?.summary??evidence?.taskOutput?.response);
  return assessSubsequentUse(output,{image5:heldout?4:3,image6:heldout?7:5,alpha:"preserved",version:"unverified"});
}
