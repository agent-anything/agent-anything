import {prepareResponses,restoreResponsesCompactedWindow,type ResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {TransformationDependencies,TransformationFinding} from "@agent-anything/context/representation";

/** The oracle remains local to the evaluator. Background eligibility is declared by its semantic owner. */
export function prepareHelarcResponsesCompactionProbe(input:{readonly model:string;readonly candidate:ResponsesCompactedWindow;
  readonly question:string;readonly oracle:{readonly id:string;readonly revision:string};readonly maximumOutputTokens:number;
  readonly background:readonly {readonly id:string;readonly text:string;readonly answerBearing:boolean}[]}){
  if(!input.question||!input.oracle.id||!input.oracle.revision||input.background.some(b=>b.answerBearing)||
    !Number.isSafeInteger(input.maximumOutputTokens)||input.maximumOutputTokens<1||digest(restoreResponsesCompactedWindow(input.candidate.raw))!==digest(input.candidate))
    throw new TypeError("compact_probe_input_invalid");
  const prepared=prepareResponses({model:input.model,purpose:{id:"context-continuation-probe",revision:"1"},stream:false,store:false,
    input:[...input.candidate.items,...input.background.map(b=>({role:"user",content:b.text})),{role:"user",content:input.question}],
    max_output_tokens:input.maximumOutputTokens});
  return {prepared,candidateDigest:input.candidate.digest,oracle:input.oracle,background:input.background.map(b=>b.id)};
}
/** A named evaluator supplies the finding; parsing ciphertext is not evaluation. */
export function helarcResponsesCompactionProbeFinding(input:{readonly probe:ReturnType<typeof prepareHelarcResponsesCompactionProbe>;
  readonly dependencies:TransformationDependencies;readonly duty:{readonly id:string;readonly revision:string};
  readonly observation:string;readonly evaluation:{readonly id:string;readonly conclusion:"supported"|"unsupported"|"unknown";readonly limitations:readonly string[]}}):TransformationFinding{
  if(!input.observation||!input.evaluation.id)throw new TypeError("compact_probe_evaluation_missing");
  return {id:input.evaluation.id,dutyId:input.duty.id,dutyRevision:input.duty.revision,kind:"continuation_probe",conclusion:input.evaluation.conclusion,
    subject:input.probe.candidateDigest,dependencies:input.dependencies,evidence:[input.observation,input.probe.prepared.digest,input.evaluation.id],
    limitations:input.evaluation.limitations,probe:{candidateDigest:input.probe.candidateDigest,
      independentOracle:`${input.probe.oracle.id}:${input.probe.oracle.revision}`,answerBearingBackground:false}};
}
