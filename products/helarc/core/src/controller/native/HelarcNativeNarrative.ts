import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readProtocolContent,type ProtocolExecutionJournal,type ProtocolPurposeAcceptance} from "@agent-anything/agent-runtime/model-access";
import type {ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import type {DelegationNarrativeSelection} from "@agent-anything/agent-runtime/delegation";

export interface HelarcNativeNarrativeReader {
  read(evidence:ModelPurposeEvidence):Promise<DelegationNarrativeSelection|null>;
}

/** Reads the accepted task interpretation, not the latest transport observation or auxiliary body. */
export function createHelarcNativeNarrativeReader(journal:ProtocolExecutionJournal):HelarcNativeNarrativeReader {
  return {async read(evidence){
    const accepted=await journal.command({kind:"acceptance",activityId:evidence.scope.activityId}) as ProtocolPurposeAcceptance|null;
    if(!accepted||digest(accepted.evidence)!==digest(evidence))throw new TypeError("helarc_native_report_source_unavailable");
    const retained=JSON.parse((await readProtocolContent(journal,accepted.result,evidence.scope.activityId,32*1024*1024)).toString());
    if(retained.format!=="helarc.native-task-decision.v1"||digest(retained.proposal?.evidence)!==digest(evidence)||!Array.isArray(retained.proposal.text))
      throw new TypeError("helarc_native_report_task_source_changed");
    const blocks=retained.proposal.text as {text:string;source:unknown}[];
    for(const block of blocks)if(typeof block.text!=="string"||!evidence.sources.some(source=>digest(source)===digest(block.source)))
      throw new TypeError("helarc_native_report_text_source_changed");
    const text=blocks.filter(block=>block.text.trim().length).map(block=>block.text).join("\n\n");
    return text?{text,origins:[{owner:"helarc",kind:"native_task_text",id:evidence.acceptance.id,revision:evidence.acceptance.revision}]}:null;
  }};
}
