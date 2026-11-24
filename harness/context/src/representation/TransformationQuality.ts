export interface TransformationDependencies {
  readonly recipient:string;
  readonly target:string;
  readonly authority:string;
  readonly source:string;
  readonly requirements:string;
  readonly method:string;
}
export interface TransformationDuty {
  readonly id:string;
  readonly revision:string;
  readonly requirement:"exact"|"semantic"|"unchanged";
  readonly permittedEvidence:readonly ("direct"|"method_assurance"|"continuation_probe")[];
}
/** A method's scoped semantic evidence, not a universal model-output schema. */
export interface PreservationFactAssessment {
  /** What was checked; an original receipt never establishes what a recipient can use. */
  readonly evidenceUse?:"original_receipt"|"recipient";
  readonly sourceReview?:{readonly conclusion:"supported"|"unsupported"|"unknown";readonly reason:string};
  readonly receiptWitness?:{readonly callId:string;readonly callGroup:string;readonly resultGroup:string;readonly resultDigest:string;
    readonly pointer:string;readonly expectedJson:string;readonly observedDigest:string|null};
  readonly id:string;
  readonly claim:string;
  readonly required:boolean;
  readonly necessity:string;
  readonly sources:readonly {readonly groupId:string;readonly excerpt:string;readonly supports?:string}[];
  readonly planReview?:{readonly outcome:string;readonly boundary:string};
  readonly status:"not_asked"|"insufficient"|"contradicted"|"demonstrated"|"unavailable";
  readonly checks:readonly {readonly questionId:string;readonly question:string;readonly coverage:"asked"|"not_asked"|"unknown";
    readonly quality:"demonstrated"|"insufficient"|"contradicted"|"not_assessed";readonly reason:string;readonly answerExcerpt:string}[];
}
export interface TransformationFinding {
  readonly id:string;
  readonly dutyId:string;
  readonly dutyRevision:string;
  readonly kind:"direct"|"method_assurance"|"continuation_probe";
  readonly conclusion:"supported"|"unsupported"|"unknown"|"not_performed";
  readonly dependencies:TransformationDependencies;
  readonly subject:string;
  readonly visibleOriginal?:{readonly finding:string;readonly subject:string;readonly proves:"ordered_original_text"};
  readonly evidence:readonly string[];
  /** Versioned purpose receipts actually used by this check (when supplied by the method). */
  readonly purposeReceipts?:readonly {readonly id:string;readonly revision:string}[];
  readonly factAssessments?:readonly PreservationFactAssessment[];
  /** The assessment owner's diagnosis. A rejected plan is not a failed observation of the candidate. */
  readonly assessmentIssue?:{readonly category:"plan_attribution"|"plan_scope"|"evidence_insufficient"|"candidate_contradiction";
    readonly reason:string;readonly requirement?:string;readonly claim?:string;readonly owners?:readonly string[];readonly groups?:readonly string[]};
  readonly useReview?:{readonly dutyCoverage:{readonly complete:boolean;readonly reason:string};
    readonly readableClaims:{readonly conclusion:"supported"|"unsupported"|"unknown";readonly reason:string}};
  readonly planGaps?:readonly {readonly missing:string;readonly reason:string;readonly groupId:string;readonly excerpt:string}[];
  readonly limitations:readonly string[];
  /** A probe may establish only named tested duties, without answers in its background. */
  readonly probe?:{readonly candidateDigest:string;readonly independentOracle:string;readonly answerBearingBackground:boolean};
}
export interface TransformationQuality {
  readonly allowed:boolean;
  readonly duties:readonly {readonly id:string;readonly conclusion:"supported"|"unsupported"|"unknown";
    readonly findings:readonly string[];readonly basis:"direct"|"method_assurance"|"continuation_probe"|"none"}[];
  readonly limitations:readonly string[];
}
/** Mechanical evidence binding only. The owner, not this function, judges natural-language preservation. */
export function assessTransformationQuality(input:{readonly subject:string;readonly dependencies:TransformationDependencies;
  readonly duties:readonly TransformationDuty[];readonly findings:readonly TransformationFinding[]}):TransformationQuality {
  const keys=["recipient","target","authority","source","requirements","method"] as const;
  if(!input.subject||keys.some(key=>!input.dependencies[key])||new Set(input.duties.map(d=>d.id)).size!==input.duties.length||
    new Set(input.findings.map(f=>f.id)).size!==input.findings.length)throw new TypeError("transformation_quality_identity_invalid");
  const limitations:string[]=[];
  const duties=input.duties.map(duty=>{
    if(!duty.id||!duty.revision||!["exact","semantic","unchanged"].includes(duty.requirement)||!duty.permittedEvidence.length||
      duty.permittedEvidence.some(k=>!["direct","method_assurance","continuation_probe"].includes(k)))throw new TypeError("transformation_duty_invalid");
    const matches=input.findings.filter(f=>f.dutyId===duty.id&&f.dutyRevision===duty.revision&&f.subject===input.subject&&
      keys.every(key=>f.dependencies[key]===input.dependencies[key]));
    const valid=matches.filter(f=>{
      if(!f.id||!f.evidence.length||f.evidence.some(e=>!e)||!duty.permittedEvidence.includes(f.kind)||
        !["supported","unsupported","unknown","not_performed"].includes(f.conclusion))return false;
      if(duty.requirement!=="semantic"&&f.kind!=="direct")return false;
      if(f.kind==="continuation_probe"&&(!f.probe||f.probe.candidateDigest!==input.subject||!f.probe.independentOracle||f.probe.answerBearingBackground))return false;
      return true;
    });
    limitations.push(...matches.flatMap(f=>f.limitations));
    const failed=valid.some(f=>f.conclusion==="unsupported"),supported=valid.find(f=>f.conclusion==="supported");
    return {id:duty.id,conclusion:failed?"unsupported" as const:supported?"supported" as const:"unknown" as const,
      findings:valid.map(f=>f.id),basis:failed||!supported?"none" as const:supported.kind};
  });
  if(input.duties.some(d=>d.requirement==="semantic"))limitations.push("Semantic retention is scoped evidence, not a proof of every future use");
  return {allowed:duties.every(d=>d.conclusion==="supported"),duties,limitations:[...new Set(limitations)]};
}
