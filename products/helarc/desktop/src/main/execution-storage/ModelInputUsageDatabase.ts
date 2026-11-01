import {modelInputValueDigest,validateAcceptedInputUsage,type AcceptedInputUsage,type InputUsageQuery} from "@agent-anything/model-interaction/input";
import {acceptedModelInputUsage} from "@agent-anything/agent-runtime/model-access";
import type {ActivityStageState,ActivityPathState,SharedAcceptanceProposal,ActivityHandoffCommand} from "@agent-anything/agent-runtime/activity";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ContextFoundationRecords} from "./ContextFoundationRecords.js";

export const MODEL_INPUT_USAGE_SCHEMA=`
CREATE TABLE model_input_usage(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,purpose TEXT NOT NULL,target TEXT NOT NULL,basis TEXT NOT NULL,schema_digest TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX model_input_usage_scope ON model_input_usage(run_id,purpose,target,basis,schema_digest,sequence DESC);
`;

export class ModelInputUsageDatabase {
  constructor(private readonly records:ContextFoundationRecords,
    private readonly stage:(id:string)=>ActivityStageState|null,private readonly path:(id:string)=>ActivityPathState|null) {}
  latest(query:InputUsageQuery):AcceptedInputUsage|null {
    for(const value of [query.runId,query.purpose,query.targetRevision,query.basisKey,query.schemaDigest])
      if(typeof value!=="string"||!value.length||value.length>4096)throw new TypeError("input_usage_query_invalid");
    const row=this.records.sql("SELECT id,value,digest FROM model_input_usage WHERE run_id=? AND purpose=? AND target=? AND basis=? AND schema_digest=? ORDER BY sequence DESC LIMIT 1")
      .get(query.runId,query.purpose,query.targetRevision,query.basisKey,query.schemaDigest) as {id:string;value:string;digest:string}|undefined;
    if(!row)return null;
    const result=JSON.parse(row.value) as AcceptedInputUsage;validateAcceptedInputUsage(result);
    if(result.id!==row.id||modelInputValueDigest(result)!==row.digest||result.runId!==query.runId||result.purpose!==query.purpose||result.targetRevision!==query.targetRevision||
      result.footprint.basisKey!==query.basisKey||result.footprint.schemaDigest!==query.schemaDigest)throw new Error("input_usage_record_corrupt");
    return result;
  }
  participant():SharedAcceptanceParticipant {
    return {owner:"model_input_usage",kinds:["accepted_usage"],prepare:(part,proposal)=>{
      const value=part.proposal as AcceptedInputUsage;this.validate(value,proposal);return structuredClone(value);
    },apply:(prepared,proposal)=>{
      const value=prepared as AcceptedInputUsage;this.validate(value,proposal);
      const digest=modelInputValueDigest(value),old=this.records.sql("SELECT digest FROM model_input_usage WHERE id=?").get(value.id) as {digest:string}|undefined;
      if(old){if(old.digest!==digest)reject("input_usage_identity_conflict");return;}
      this.records.sql("INSERT INTO model_input_usage(id,run_id,purpose,target,basis,schema_digest,value,digest) VALUES (?,?,?,?,?,?,?,?)")
        .run(value.id,value.runId,value.purpose,value.targetRevision,value.footprint.basisKey,value.footprint.schemaDigest,JSON.stringify(value),digest);
      this.records.fact(value.runId,"model-input-measurement",value.id,"input_usage_accepted",{usage:value});
    },validate:(prepared,proposal)=>{
      const value=prepared as AcceptedInputUsage,stage=this.stage(value.stageId);
      if(stage?.status!=="accepted"||stage.receipt?.id!==proposal.id||stage.receipt.resultId!==value.rawResultId)reject("input_usage_acceptance_missing");
    }};
  }
  private validate(value:AcceptedInputUsage,proposal:SharedAcceptanceProposal):void {
    validateAcceptedInputUsage(value);
    const stage=this.stage(value.stageId),path=stage?this.path(stage.request.pathId):null;
    const original=stage?acceptedModelInputUsage(stage,proposal.id):null;
    const part=proposal.parts.find(p=>p.owner==="activity"&&p.kind==="professional_acceptance"&&
      (p.proposal as Extract<ActivityHandoffCommand,{kind:"accept"}>)?.receipt?.requestId===value.stageId);
    if(!stage||!path||!part||proposal.scope!==value.runId||proposal.actor!==path.intent.owner||path.intent.runId!==value.runId||
      value.acceptanceId!==proposal.id||!original||modelInputValueDigest(original)!==modelInputValueDigest(value))reject("input_usage_original_exchange_mismatch");
  }
}
function reject(code:string):never {throw new SharedAcceptanceRejection("model_input_usage",code);}
