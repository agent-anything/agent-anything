import Database from "better-sqlite3";
import {RESPONSES_COMPACT_METHOD} from "@agent-anything/provider-integrations/native";
import {EXECUTION_ADMISSION_RESOLUTION_SCHEMA, type ExecutionAdmissionResolution} from "./ExecutionAdmissionResolution.js";
import {activityCommandReceipt} from "@agent-anything/agent-runtime/activity";
import {ProtocolExecutionDatabase,PROTOCOL_EXECUTION_SCHEMA,PROTOCOL_RECONCILIATION_SCHEMA,PROTOCOL_ADMISSION_SCHEMA} from "./ProtocolExecutionDatabase.js";
import {PROTOCOL_EVIDENCE_SCHEMA,PROTOCOL_USAGE_ACCESS_SCHEMA} from "./ProtocolEvidenceDatabase.js";
import {ACTIVITY_RECONSIDERATION_ACCESS_SCHEMA} from "./ActivityReconsiderationDatabase.js";
import {MaterialDeliveryDatabase,MATERIAL_DELIVERY_SCHEMA,MATERIAL_DELIVERY_ACCESS_SCHEMA} from "./MaterialDeliveryDatabase.js";
import {helarcConversationSeed,helarcNativeConversationSeed, type HelarcConversationHandoff} from "../run/HelarcConversationHandoff.js";
import {snapshotTaskInteractionSeed,isNativeTaskSeed} from "@agent-anything/agent-runtime/decision";
import {HELARC_CONTROLLER_CAPABILITY} from "@agent-anything/helarc/controller";
import {contextDeliveryFactSource,contextDeliveryFact,inputSupplyFactSource} from "@agent-anything/agent-runtime/context-representation";
import {validateRetainedExecutionAdmission,originalPreparationLimitation} from "./HelarcExecutionAdmissionValidation.js";
import {ActivityHandoffDatabase, ACTIVITY_HANDOFF_SCHEMA} from "./ActivityHandoffDatabase.js";
import {SharedAcceptanceDatabase, SHARED_ACCEPTANCE_SCHEMA} from "./SharedAcceptanceDatabase.js";
import {reportRecipientAdmission} from "./ReportRecipientAdmission.js";
import {ContextFoundationRecords,CONTEXT_FOUNDATION_FACT_SCHEMA} from "./ContextFoundationRecords.js";
import {MaterialCustodyDatabase,MATERIAL_CUSTODY_SCHEMA} from "./MaterialCustodyDatabase.js";
import {RepresentationDatabase,REPRESENTATION_SCHEMA} from "./RepresentationDatabase.js";
import {ContextSelectionDatabase,CONTEXT_SELECTION_SCHEMA,CONTEXT_SELECTION_ACCESS_SCHEMA} from "./ContextSelectionDatabase.js";
import {ContextPreparationDecisionDatabase,CONTEXT_PREPARATION_DECISION_SCHEMA} from "./ContextPreparationDecisionDatabase.js";
import {ModelInputUsageDatabase,MODEL_INPUT_USAGE_SCHEMA} from "./ModelInputUsageDatabase.js";
import {InputSupplyResponsibilityDatabase,INPUT_SUPPLY_RESPONSIBILITY_SCHEMA} from "./InputSupplyResponsibilityDatabase.js";
import {assertExecutionRecording, type ExecutionRecording, type ExecutionRecordingRegistration} from "./ExecutionRecording.js";
import {ContextPreparationDatabase, CONTEXT_PREPARATION_SCHEMA, type ContextPreparationCommand} from "./ContextPreparationDatabase.js";
import {unpackExecutionContent, ExecutionContentCache, ExecutionContentEncoder, ExecutionContentScope, ExecutionContentStatistics, snapshotEncodedExecutionContent, EXECUTION_CONTENT_LIMITS,
  type ExecutionContentBlock, type ExecutionContentRoot} from "./ExecutionContent.js";
import { FileMaterialDatabase, FILE_MATERIAL_SCHEMA } from "./FileMaterialDatabase.js";
import {ContextMaterialDatabase, CONTEXT_MATERIAL_SCHEMA, type ContextMaterialCommand, type ContextMaterialValue} from "./ContextMaterialDatabase.js";
import {projectContextMaterials} from "./ContextMaterialProjection.js";
import {RunMaterialTransfers} from "./RunMaterialTransfers.js";
import {runActivityLifetime} from "./RunActivityLifetime.js";
import {projectProcessOutputMaterial} from "./ProcessOutputMaterialProjection.js";
import {snapshotContextMaterialRefs} from "@agent-anything/context/material";
import {snapshotExecutionReferenceTransfer, type ExecutionReferenceTransfer, type ExecutionReferencePage} from "@agent-anything/operation-catalog/evidence";
import type { HelarcExecutionAdmission, HelarcExecutionDiscovery } from "./HelarcExecutionAdmission.js";
import { createHash } from "node:crypto";
import {helarcAcceptedObservation} from "../context/HelarcAcceptedObservation.js";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import { isDeepStrictEqual } from "node:util";
import { snapshotExecutionEvidence, snapshotCompensationAssociation, snapshotExecutionEvidenceRef, executionEvidenceKey, evidenceMemberRefs,
  type ExecutionEvidenceRecord, type ExecutionEvidenceRef, type CompensationAssociation } from "@agent-anything/operation-catalog/evidence";
import type { ActionRecoveryRecords } from "@agent-anything/action-execution/enforcement";
import { validateAgentHookCheckpoint, type AgentHookInvocationCheckpoint } from "@agent-anything/agent-hooks/execution";
import { validateProcessCheckpoint, validateShellSessionCommit, type ShellSessionCommit } from "@agent-anything/helarc-local-environment/command";
import {validateProtectedEnvironment, type StoredProcessCheckpoint as ProcessCheckpoint} from "./ExecutionEnvironmentProtection.js";
import { CanonicalActionLedger } from "@agent-anything/action-execution/coordination";
import { validateRunTreeCommit, type RunTreeCommit, type RunTreeCommitReceipt, type RunTreeRecoveryRecords, type RetainedRunTreeMember } from "@agent-anything/agent-runtime/execution-coordinator";
import {
  EXECUTION_STORE_LIMITS, ExecutionStoreError,
  type ActionOwnerRecord, type ExecutionRecordReceipt,
  type ExecutionOwnerCommit,
  type FileMaterialStoreCommand, type FileMaterialStoreValue,
} from "./ExecutionStoreProtocol.js";

const FORMAT = 50;
const ADDITIONS=PROTOCOL_EXECUTION_SCHEMA+MATERIAL_DELIVERY_SCHEMA;
const FORMAT_43_SCHEMA = `
CREATE TABLE store (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE execution_content (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE action_records (
  sequence INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
  run_id TEXT NOT NULL, action_id TEXT NOT NULL, kind TEXT NOT NULL,
  digest TEXT NOT NULL, value TEXT NOT NULL
);
CREATE INDEX action_records_owner ON action_records(run_id, action_id, sequence);
CREATE TABLE execution_commits (
  record_id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL, generation INTEGER NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL,
  UNIQUE(owner, owner_id, revision)
);
CREATE TABLE run_tree_commits (
  record_id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  generation INTEGER NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL,
  UNIQUE(root_run_id, revision)
);
CREATE TABLE run_tree_members (run_id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL);
CREATE TABLE hook_records (
  id TEXT NOT NULL, stage INTEGER NOT NULL CHECK(stage IN (0,1)), generation INTEGER NOT NULL,
  digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id, stage)
);
CREATE TABLE process_records (
  execution_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
  digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(execution_id, revision)
);
CREATE TABLE shell_sessions (
  run_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
  digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id, revision)
);
CREATE TABLE product_admissions (
  root_run_id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL, delivered INTEGER NOT NULL CHECK(delivered IN (0,1))
);
CREATE TABLE execution_recordings (root_run_id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE execution_evidence (
  reference_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL
);
CREATE TABLE execution_evidence_members (reference_key TEXT PRIMARY KEY, execution_key TEXT NOT NULL REFERENCES execution_evidence(reference_key));
CREATE TABLE execution_reference_transfers (id TEXT PRIMARY KEY, recipient_run_id TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX execution_transfer_recipient ON execution_reference_transfers(recipient_run_id);
CREATE TABLE compensation_associations (
  invocation_id TEXT PRIMARY KEY, association_id TEXT UNIQUE NOT NULL, generation INTEGER NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL
);
${FILE_MATERIAL_SCHEMA}
${CONTEXT_MATERIAL_SCHEMA}
${CONTEXT_PREPARATION_SCHEMA}
${ACTIVITY_HANDOFF_SCHEMA}
${SHARED_ACCEPTANCE_SCHEMA}
${CONTEXT_FOUNDATION_FACT_SCHEMA}
${MATERIAL_CUSTODY_SCHEMA}
${REPRESENTATION_SCHEMA}
${CONTEXT_SELECTION_SCHEMA}
${CONTEXT_PREPARATION_DECISION_SCHEMA}
${MODEL_INPUT_USAGE_SCHEMA}
${INPUT_SUPPLY_RESPONSIBILITY_SCHEMA}
`;
const FORMAT_44_SCHEMA=FORMAT_43_SCHEMA+ADDITIONS;
const FORMAT_45_SCHEMA=FORMAT_44_SCHEMA+PROTOCOL_EVIDENCE_SCHEMA;
const FORMAT_46_SCHEMA=FORMAT_45_SCHEMA+PROTOCOL_RECONCILIATION_SCHEMA;
const MEMBERSHIP_INDEX="CREATE INDEX run_tree_members_root ON run_tree_members(root_run_id);";
const FORMAT_47_SCHEMA=FORMAT_46_SCHEMA+MEMBERSHIP_INDEX;
const RETENTION_INDEXES="CREATE INDEX protocol_effects_activity ON protocol_effects(activity_id);CREATE INDEX protocol_deliveries_activity ON protocol_deliveries(activity_id);";
const FORMAT_48_SCHEMA=FORMAT_47_SCHEMA+EXECUTION_ADMISSION_RESOLUTION_SCHEMA+RETENTION_INDEXES;
const FORMAT_49_SCHEMA=FORMAT_48_SCHEMA+PROTOCOL_ADMISSION_SCHEMA;
const FORMAT_50_ADDITIONS=PROTOCOL_USAGE_ACCESS_SCHEMA+ACTIVITY_RECONSIDERATION_ACCESS_SCHEMA+MATERIAL_DELIVERY_ACCESS_SCHEMA+CONTEXT_SELECTION_ACCESS_SCHEMA;
const SCHEMA=FORMAT_49_SCHEMA+FORMAT_50_ADDITIONS;
const schemaManifests=new Map<number,unknown>();
function supportedSchema(format:number):unknown {
  if(![43,44,45,46,47,48,49,50].includes(format))throw new ExecutionStoreError("execution_store_format_invalid");
  let manifest=schemaManifests.get(format);
  if(!manifest){
    const reference=new Database(":memory:");
    try{reference.exec(format===43?FORMAT_43_SCHEMA:format===44?FORMAT_44_SCHEMA:format===45?FORMAT_45_SCHEMA:format===46?FORMAT_46_SCHEMA:format===47?FORMAT_47_SCHEMA:format===48?FORMAT_48_SCHEMA:format===49?FORMAT_49_SCHEMA:SCHEMA);manifest=reference.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();schemaManifests.set(format,manifest);}
    finally{reference.close();}
  }
  return manifest;
}
interface ProcessRow { execution_id: string; run_id: string; revision: number; digest: string; value: string; }
interface StoredActionRow {
  sequence: number; record_id: string; generation: number; run_id: string;
  action_id: string; kind: ActionOwnerRecord["kind"]; digest: string; value: string;
}

/** Host-only authoritative execution facts. Never opens an Inspection database. */
export class ExecutionDatabase {
  readonly generation: number;
  private readonly ownership: Database.Database;
  private readonly data: Database.Database;
  private readonly fileMaterials: FileMaterialDatabase;
  private readonly contextMaterials: ContextMaterialDatabase;
  private readonly contextPreparations: ContextPreparationDatabase;
  private readonly activityHandoffs: ActivityHandoffDatabase;
  private readonly sharedAcceptance: SharedAcceptanceDatabase;
  private readonly contextFoundationRecords:ContextFoundationRecords;
  private readonly materialCustody:MaterialCustodyDatabase;
  private readonly materialTransfers:RunMaterialTransfers;
  private readonly representations:RepresentationDatabase;
  private readonly contextSelections:ContextSelectionDatabase;
  private readonly contextPolicy:ContextPreparationDecisionDatabase;
  private readonly inputUsage:ModelInputUsageDatabase;
  private readonly inputSupplies:InputSupplyResponsibilityDatabase;
  private readonly protocolExecution:ProtocolExecutionDatabase;
  private readonly materialDeliveries:MaterialDeliveryDatabase;
  private closed = false;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly runControls = new Map<string, import("./RunExecutionControl.js").RunExecutionControl>();
  private readonly contentStatistics: ExecutionContentStatistics;
  private readonly contentCache: ExecutionContentCache;
  private readonly contentEncoder: ExecutionContentEncoder;
  private contentScope: ExecutionContentScope | undefined;
  private readonly timings = new Map<string, {count: number; totalMs: number; maxMs: number}>();
  private readContext: {
    ownerConfirmed: boolean;
    blocks: Map<string, ExecutionContentBlock>;
    checkpoints: Map<string, unknown>;
    owners: Map<string, ExecutionOwnerCommit>;
    trees: Map<string, RunTreeCommit>;
  } | null = null;

  constructor(directory: string, private readonly performanceDiagnostics = false) {
    this.contentStatistics = new ExecutionContentStatistics(performanceDiagnostics);
    this.contentCache = new ExecutionContentCache(undefined, undefined, this.contentStatistics);
    this.contentEncoder = new ExecutionContentEncoder(undefined, this.contentStatistics);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const root = realpathSync(directory);
    this.ownership = new Database(join(root, "ownership.sqlite"), { timeout: 0 });
    try {
      this.ownership.pragma("trusted_schema = OFF");
      if (this.ownership.pragma("journal_mode", { simple: true }) !== "delete") {
        throw new ExecutionStoreError("execution_ownership_format_invalid");
      }
      this.ownership.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.ownership.close();
      if (isBusy(error)) throw new ExecutionStoreError("execution_store_already_owned");
      throw error;
    }
    let data: Database.Database | undefined;
    try {
      const path = join(root, "execution.sqlite");
      const fresh = !existsSync(path);
      data = new Database(path, { timeout: 250 });
      this.data = data;
      this.fileMaterials = new FileMaterialDatabase(data);
      this.contextMaterials = new ContextMaterialDatabase(data);
      this.contextPreparations = new ContextPreparationDatabase(data, value => this.retainContent(value), root => this.hydrateContent(root));
      this.activityHandoffs = new ActivityHandoffDatabase(data, value => this.retainContent(value), root => this.hydrateContent(root),()=>this.generation,
        work=>this.checkpointTransaction(work),(phase,work)=>this.timed(`activity.${phase}`,work));
      this.contextFoundationRecords=new ContextFoundationRecords(data);
      this.materialCustody=new MaterialCustodyDatabase(data,this.contextFoundationRecords,undefined,hold=>this.contextSelections.mayRelease(hold)&&this.materialDeliveries.mayRelease(hold),
        (name,value)=>this.contentStatistics.add(name,value));
      this.protocolExecution=new ProtocolExecutionDatabase(data,()=>this.generation,(activity,input,existing)=>this.contextSelections.claimNativeInput(activity,input,existing),
        runId=>this.readRunControl(runId),state=>helarcAcceptedObservation(state,(pathId,stageId)=>
          this.activityHandoffs.command({kind:"read_snapshot",pathId,requestIds:[stageId],inputNeedIds:[]}).activityValue as import("@agent-anything/agent-runtime/activity").ActivitySnapshot));
      this.materialDeliveries=new MaterialDeliveryDatabase(data,this.materialCustody,hold=>this.contextSelections.deliveryGuard(hold));
      this.representations=new RepresentationDatabase(data,this.contextFoundationRecords,this.materialCustody,record=>!record.method||
        (record.method.protocolConfirmation?record.method.id===RESPONSES_COMPACT_METHOD.id&&record.method.revision===RESPONSES_COMPACT_METHOD.revision&&
          this.protocolExecution.confirmProfessionalResult(record.runId,record.owner,record.target,record.method.activityId,{protocol:"openai.responses",nativeKind:"response.compaction"},
          {id:record.method.rawResultId,revision:record.method.protocolConfirmation.rawRevision},
          {id:record.method.acceptanceId,revision:record.method.protocolConfirmation.acceptanceRevision}):
        this.activityHandoffs.confirmProfessionalResult(record.runId,record.owner,record.method.activityId,record.method.rawResultId,record.method.acceptanceId)));
      this.contextSelections=new ContextSelectionDatabase(data,this.contextFoundationRecords,this.materialCustody,this.representations,
        value=>this.retainContent(value),root=>this.hydrateContent(root),(...args)=>this.activityHandoffs.confirmInputResult(...args),
        (...args)=>this.activityHandoffs.confirmInputAttempt(...args),path=>this.activityHandoffs.pathSettled(path),
        (runId,input)=>this.confirmPreparedInput(runId,input),
        id=>this.activityHandoffs.command({kind:"read_path",pathId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPathState|null,{
          register:recipient=>{this.activityHandoffs.command({kind:"register_fact_source",source:contextDeliveryFactSource(recipient)});},
          publish:(recipient,id,transition,basis)=>{
            this.activityHandoffs.command({kind:"register_fact_source",source:contextDeliveryFactSource(recipient)});
            this.activityHandoffs.command({kind:"publish_fact",fact:contextDeliveryFact(recipient,id,transition,basis)});
          },
        },{
          readFact:id=>this.activityHandoffs.command({kind:"read_fact",id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPublishedFact|null,
          subscription:id=>this.activityHandoffs.command({kind:"read_reconsideration_state",subscriptionId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationState|null,
          stage:id=>this.activityHandoffs.command({kind:"read_stage",requestId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityStageState|null,
        },this.protocolExecution.contextConsumer());
      this.contextPolicy=new ContextPreparationDecisionDatabase(this.contextFoundationRecords,value=>this.retainContent(value),root=>this.hydrateContent(root),
        id=>this.contextSelections.registeredScope(id),id=>this.activityHandoffs.command({kind:"read_path",pathId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPathState|null,
        id=>this.activityHandoffs.pathSettled(id),
        id=>this.activityHandoffs.command({kind:"resource_allowance",pathId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityResourceAllowance,
        (runId,input)=>this.confirmPreparedInput(runId,input),id=>this.sharedAcceptance.query(id),
        id=>this.activityHandoffs.command({kind:"read_stage",requestId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityStageState|null,
        input=>{const judgment=this.representations.judgment(input.judgmentId);
          return Boolean(judgment&&judgment.kind==="combination"&&judgment.owner===input.scope.owner&&judgment.runId===input.scope.runId&&
            judgment.purpose===input.scope.purpose&&judgment.target===input.scope.target&&judgment.dependencies.inputDigest===input.exactInputDigest&&
            judgment.dependencies.bodyDigest===input.bodyDigest&&(!input.allowed||judgment.conclusion==="supported")&&
            (!input.capacity||judgment.dependencies.capacityDigest===modelInputValueDigest(input.capacity)));},
        input=>this.contextSelections.confirmsRecipientReadiness(input),
        (input,scope)=>this.protocolExecution.confirmInputRejection(input,scope)&&this.contextSelections.confirmsRecipientRejection(input,scope));
      this.inputSupplies=new InputSupplyResponsibilityDatabase(this.contextFoundationRecords,{
        settled:id=>this.activityHandoffs.pathSettled(id),
        closure:id=>this.activityHandoffs.reconsiderationClosure(id),
        scheduling:workId=>this.activityHandoffs.command({kind:"read_schedule",workId}).activityValue as import("@agent-anything/agent-runtime/activity").ActivitySchedulingAcceptance|null,
        subscription:id=>(this.activityHandoffs.command({kind:"read_reconsideration",subscriptionId:id,limit:1}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot|null)?.state??null,
        need:id=>this.activityHandoffs.command({kind:"read_input_need",id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityInputNeed|null,
        path:id=>this.activityHandoffs.command({kind:"read_path",pathId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPathState|null,
        stage:id=>this.activityHandoffs.command({kind:"read_stage",requestId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityStageState|null,
      },(binding,revision,kind)=>{
        const source=inputSupplyFactSource(binding);
        this.activityHandoffs.command({kind:"register_fact_source",source});
        this.activityHandoffs.command({kind:"publish_fact",fact:{id:`${source.id}:${kind}:${revision}`,sourceId:source.id,
          ref:{owner:binding.owner,kind:`input_supply_${kind}`,id:binding.needId,revision:String(revision)}}});
      },id=>this.contextSelections.inputSupplySelection(id));
      this.inputUsage=new ModelInputUsageDatabase(this.contextFoundationRecords,
        id=>this.activityHandoffs.command({kind:"read_stage",requestId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityStageState|null,
        id=>this.activityHandoffs.command({kind:"read_path",pathId:id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPathState|null);
      this.sharedAcceptance = new SharedAcceptanceDatabase(data,[this.activityHandoffs.acceptanceParticipant(),this.materialCustody.participant(),this.representations.participant(),...this.contextSelections.participants(),this.contextPolicy.participant(),this.inputSupplies.participant(),this.inputUsage.participant(),this.protocolExecution.participant(),this.materialDeliveries.participant(),
        reportRecipientAdmission(id=>this.readRunControl(id),id=>this.activityHandoffs.command({kind:"read_fact",id}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPublishedFact|null,
          (...args)=>this.materialCustody.withdrawGrant(...args))],
        (phase,work)=>this.timed(`shared_acceptance.${phase}`,work));
      this.materialTransfers=new RunMaterialTransfers(this.contextMaterials,this.materialCustody,this.sharedAcceptance,runId=>{
        const head=this.readLatestOwner("run",runId);return head?.kind==="run"?head.value:null;
      });
      data.pragma("trusted_schema = OFF");
      data.pragma("journal_mode = WAL");
      data.pragma("synchronous = FULL");
      if (data.pragma("journal_mode", { simple: true }) !== "wal" ||
          data.pragma("synchronous", { simple: true }) !== 2) {
        throw new ExecutionStoreError("execution_storage_durability_unavailable");
      }
      if (fresh) data.transaction(() => {
        data!.exec(SCHEMA);
        data!.prepare("INSERT INTO store VALUES (1, ?, 0)").run(FORMAT);
      })();
      if(!fresh){
        const version=data.prepare("SELECT version FROM store WHERE id=1").get() as {version:number}|undefined;
        if(version?.version===43||version?.version===44||version?.version===45||version?.version===46||version?.version===47||version?.version===48||version?.version===49){
          this.validateSchema(version.version);
          data.transaction(()=>{data!.exec((version.version===43?ADDITIONS:"")+(version.version<45?PROTOCOL_EVIDENCE_SCHEMA:"")+(version.version<46?PROTOCOL_RECONCILIATION_SCHEMA:"")+(version.version<47?MEMBERSHIP_INDEX:"")+(version.version<48?EXECUTION_ADMISSION_RESOLUTION_SCHEMA+RETENTION_INDEXES:"")+(version.version<49?PROTOCOL_ADMISSION_SCHEMA:"")+FORMAT_50_ADDITIONS);data!.prepare("UPDATE store SET version=? WHERE id=1").run(FORMAT);this.validateSchema();})();
        }
      }
      this.validateSchema();
      this.generation = data.transaction(() => {
        const row = data!.prepare("SELECT generation FROM store WHERE id=1").get() as { generation: number };
        if (!Number.isSafeInteger(row.generation) || row.generation < 0 || row.generation >= Number.MAX_SAFE_INTEGER) {
          throw new ExecutionStoreError("execution_generation_invalid");
        }
        const next = row.generation + 1;
        data!.prepare("UPDATE store SET generation=? WHERE id=1").run(next);
        return next;
      })();
    } catch (error) {
      data?.close();
      this.ownership.close();
      throw error;
    }
  }

  recordingReplayBounds(generation:number,rootRunId:string):import("./ExecutionRecording.js").RecordingReplayBounds {
    this.assertOwner(generation);token(rootRunId);
    return this.statement(`SELECT
      (SELECT COALESCE(MAX(rowid),0) FROM run_tree_members WHERE root_run_id=?) AS members,
      (SELECT COALESCE(MAX(sequence),0) FROM activity_facts) AS activity,
      (SELECT COALESCE(MAX(sequence),0) FROM context_foundation_facts) AS context,
      (SELECT COALESCE(MAX(sequence),0) FROM protocol_facts) AS protocol,
      (SELECT COALESCE(MAX(sequence),0) FROM material_delivery_facts) AS material`).get(rootRunId) as import("./ExecutionRecording.js").RecordingReplayBounds;
  }
  registerRecording(generation: number, current: ExecutionRecording): ExecutionRecordingRegistration {
    this.assertOwner(generation);
    assertExecutionRecording(current);
    return this.data.transaction(() => {
      this.assertOwner(generation);
      if (!this.statement("SELECT 1 FROM product_admissions WHERE root_run_id=?").get(current.runId)) {
        throw new ExecutionStoreError("execution_recording_run_unavailable");
      }
      const row = this.statement("SELECT digest,value FROM execution_recordings WHERE root_run_id=?").get(current.runId) as {digest: string; value: string} | undefined;
      const prior = row ? JSON.parse(row.value) as ExecutionRecordingRegistration : null;
      if (prior) {
        if (digest(prior) !== row!.digest) throw new ExecutionStoreError("execution_records_corrupt");
        assertExecutionRecording(prior.current);
        if (prior.previous) assertExecutionRecording(prior.previous);
        if (prior.current.runId !== current.runId) throw new ExecutionStoreError("execution_records_corrupt");
        if (prior.current.sourceId === current.sourceId && prior.current.datasetId === current.datasetId) return prior;
      }
      const next = {current, previous: prior?.current ?? null};
      const encoded = encode(next);
      this.statement("INSERT INTO execution_recordings VALUES (?,?,?) ON CONFLICT(root_run_id) DO UPDATE SET digest=excluded.digest,value=excluded.value")
        .run(current.runId, encoded.digest, encoded.text);
      return next;
    })();
  }

  recordAction(generation: number, input: ActionOwnerRecord): ExecutionRecordReceipt {
    this.assertOwner(generation);
    const encoded = encode(input);
    const record = JSON.parse(encoded.text) as ActionOwnerRecord;
    const identity = actionRecordIdentity(record);
    return this.data.transaction(() => {
      this.assertOwner(generation);
      const prior = this.row(identity.recordId);
      if (prior) {
        if (prior.digest !== encoded.digest) throw new ExecutionStoreError("execution_record_conflict");
        this.decode(prior);
        return receipt(prior);
      }
      this.validateActionReferences(record, identity.runId, identity.actionId);
      const row = this.data.prepare(`INSERT INTO action_records
        (record_id,generation,run_id,action_id,kind,digest,value) VALUES (?,?,?,?,?,?,?)
        RETURNING sequence`).get(identity.recordId, generation, identity.runId, identity.actionId,
          record.kind, encoded.digest, encoded.text) as { sequence: number };
      return { recordId: identity.recordId, generation, sequence: row.sequence, digest: encoded.digest };
    })();
  }

  fileMaterialCommand(generation: number, command: FileMaterialStoreCommand): FileMaterialStoreValue {
    this.assertOwner(generation);
    const owner = this.fileMaterials;
    switch (command.kind) {
      case "reserve": return owner.reserve(command.preparation);
      case "append": owner.append(command.reference, command.offset, command.base64); return null;
      case "publish": return owner.publish(command.reference, command.digest, command.at);
      case "read": return owner.read(command.reference);
      case "read_range": return owner.readRange(command.reference, command.offset, command.length);
      case "abort": return owner.abort(command.reference, command.reason, command.at);
      case "pin": return owner.pin(command.reference, command.ownerId);
      case "release": return owner.release(command.reference, command.ownerId, command.at);
      case "expire": return owner.expire(command.at);
    }
  }

  contextMaterialCommand(generation: number, command: ContextMaterialCommand): ContextMaterialValue {
    this.assertOwner(generation);
    if(command.kind==="search_scope")return {legacy:this.contextMaterials.searchFrontier(command.runId),custody:this.materialCustody.searchFrontier()};
    return this.timed(`context_material.${command.kind}`, () => this.contextMaterials.command(command));
  }
  takeContextMaterialObservations() {return this.contextMaterials.takeObservations();}

  protocolJournalCommand(generation:number,command:import("@agent-anything/agent-runtime/model-access").ProtocolJournalCommand) {
    this.assertOwner(generation);return this.timed(`protocol_journal.${command.kind}`,()=>({protocolJournalValue:this.protocolExecution.command(command)}));
  }
  materialDeliveryQuery(generation:number,query:import("@agent-anything/context/custody").MaterialDeliveryQuery){
    this.assertOwner(generation);return this.timed(`material_delivery.${query.kind}`,()=>({materialDeliveryValue:this.materialDeliveries.query(query)}));
  }
  materialDeliveryFacts(generation:number,runId:string,after:number,limit:number){
    this.assertOwner(generation);return {materialDeliveryFacts:this.materialDeliveries.facts(runId,after,limit)};
  }
  takeProtocolObservations(){return this.closed?[]:this.protocolExecution.takeObservations();}
  takeMaterialDeliveryObservations(){return this.closed?[]:this.materialDeliveries.takeObservations();}

  contextPreparationCommand(generation: number, command: ContextPreparationCommand): {preparationValue: unknown} {
    this.assertOwner(generation);
    return this.timed(`context_preparation.${command.kind}`, () => this.contextPreparations.command(command));
  }

  activityHandoffCommand(generation: number, command: import("@agent-anything/agent-runtime/activity").ActivityHandoffCommand,returnKind?:"receipt") {
    this.assertOwner(generation);
    if(returnKind&&!["admit","save_raw","claim_processing","accept","settle"].includes(command.kind))throw new TypeError("activity_command_receipt_unsupported");
    if (command.kind === "claim_processing" && command.claim.executor.generation !== generation ||
        (command.kind === "accept" || command.kind === "settle") && command.executor.generation !== generation) throw new ExecutionStoreError("activity_processing_owner_stale");
    return this.timed(`activity_handoff.${command.kind}`, () => {
      if(command.kind==="accept_reconsideration") {
        const snapshot=this.activityHandoffs.command({kind:"read_reconsideration",subscriptionId:command.receipt.subscriptionId,limit:1}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
        const receipt=this.sharedAcceptance.accept({id:command.receipt.id,scope:snapshot.state.subscription.runId,actor:snapshot.state.subscription.owner,
          parts:[...(command.participants??[]),{owner:"activity",kind:"reconsideration_acceptance",proposal:command.receipt}]});
        if(receipt.outcome==="rejected")throw new ExecutionStoreError(receipt.rejection!.code);
        return {activityValue:this.activityHandoffs.command({kind:"read_reconsideration",subscriptionId:command.receipt.subscriptionId,limit:1}).activityValue};
      }
      if (command.kind === "accept" || command.kind === "settle" || command.kind === "stop_professional_path") {
        const path = this.activityHandoffs.stageScope(command.receipt.requestId);
        if (!path) throw new ExecutionStoreError("activity_stage_missing");
        const receipt = this.sharedAcceptance.accept({id:command.receipt.id,scope:path.intent.runId,actor:command.receipt.owner,
          parts:[{owner:"activity",kind:command.kind==="stop_professional_path"?"professional_stop":command.kind==="settle"?"result_settlement":"professional_acceptance",proposal:command},
            ...("participants" in command?command.participants??[]:[])]});
        if (receipt.outcome === "rejected") throw new ExecutionStoreError(receipt.rejection!.code);
        if(returnKind&&command.kind!=="stop_professional_path")return {activityValue:this.activityHandoffs.stageReceipt(command.receipt.requestId,command.kind)};
        return this.activityHandoffs.command({kind:"read_stage",requestId:command.receipt.requestId});
      }
      const result=this.activityHandoffs.command(command);
      return returnKind?{activityValue:activityCommandReceipt(command,result.activityValue as import("@agent-anything/agent-runtime/activity").ActivityStageState)}:result;
    });
  }

  querySharedAcceptance(generation: number, id: string) {this.assertOwner(generation); return this.sharedAcceptance.query(id);}
  takeActivityObservations() {return this.closed ? [] : this.activityHandoffs.takeObservations();}
  acceptShared(generation:number,proposal:import("@agent-anything/agent-runtime/activity").SharedAcceptanceProposal) {
    this.assertOwner(generation);
    return this.timed("shared_acceptance",()=>({acceptanceValue:this.sharedAcceptance.accept(proposal)}));
  }
  materialCustodyCommand(generation:number,command:import("@agent-anything/context/custody").MaterialCustodyCommand) {
    this.assertOwner(generation);return this.timed(`custody.${command.kind}`,()=>({custodyValue:this.materialCustody.command(command)}));
  }
  representationCommand(generation:number,command:import("@agent-anything/context/representation").RepresentationCommand) {
    this.assertOwner(generation);return this.timed(`representation.${command.kind}`,()=>({representationValue:this.representations.command(command)}));
  }
  selectionCommand(generation:number,command:import("@agent-anything/context/selection").ContextSelectionCommand) {
    this.assertOwner(generation);return this.timed(`selection.${command.kind}`,()=>({selectionValue:this.contextSelections.command(command)}));
  }
  contextPolicyQuery(generation:number,query:import("@agent-anything/agent-runtime/context-representation").ContextPreparationDecisionQuery) {
    this.assertOwner(generation);return this.timed(`context_policy.${query.kind}`,()=>({contextPolicyValue:this.contextPolicy.query(query)}));
  }
  modelInputUsage(generation:number,query:import("@agent-anything/model-interaction/input").InputUsageQuery) {
    this.assertOwner(generation);return this.timed("model_input_usage.latest",()=>({inputUsageValue:this.inputUsage.latest(query)}));
  }
  inputSupplyQuery(generation:number,query:import("@agent-anything/agent-runtime/context-representation").InputSupplyResponsibilityQuery) {
    this.assertOwner(generation);return this.timed(`input_supply.${query.kind}`,()=>({inputSupplyValue:this.inputSupplies.query(query)}));
  }
  contextPolicyInvestments(generation:number,input:{scopeId:string;afterWorkId:string|null;limit:number}) {
    this.assertOwner(generation);return this.timed("context_policy.investments",()=>({contextPolicyInvestments:this.contextPolicy.investments(input)}));
  }
  private confirmPreparedInput(runId:string,input:import("@agent-anything/agent-runtime/context-representation").PreparedContextInput):boolean {
    const stage=this.activityHandoffs.command({kind:"read_stage",requestId:input.preparationStageId}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityStageState|null;
    if(!stage || stage.status!=="accepted" || !stage.result || stage.result.outcome!=="returned")return false;
    const path=this.activityHandoffs.command({kind:"read_path",pathId:stage.request.pathId}).activityValue as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    const result=stage.receipt?.progress as {state?:string;prepared?:unknown}|undefined;
    const preparation=stage.request.input as {request?:{kind?:string;demand?:unknown}};
    return path.intent.runId===runId && path.intent.purpose.contract.inputOwner==="context-representation" &&
      ["organize","measure"].includes(stage.request.stageKind) && preparation.request?.kind==="context_input_preparation" &&
      modelInputValueDigest(preparation.request.demand)===modelInputValueDigest(input.demand) && result?.state==="prepared" &&
      modelInputValueDigest(result.prepared)===modelInputValueDigest(input);
  }
  contextFoundationFacts(runId:string,after:number,limit:number) {
    this.assertOwner(this.generation);return {contextFacts:this.contextFoundationRecords.facts(runId,after,limit)};
  }
  takeContextFoundationObservations() {return this.closed?[]:this.contextFoundationRecords.takeObservations();}

  commitExecutionEvidence(generation: number, input: ExecutionEvidenceRecord): void {
    this.assertOwner(generation);
    const record = snapshotExecutionEvidence(input);
    const key = executionEvidenceKey(record.ref);
    const encoded = encode(record);
    this.data.transaction(() => {
      this.assertOwner(generation);
      const prior = this.readExecutionEvidence(record.ref);
      if (prior) {
        if (!equal(prior, record)) throw new ExecutionStoreError("execution_evidence_conflict");
        return;
      }
      const refs = evidenceMemberRefs(record).map(executionEvidenceKey);
      for (const member of refs) {
        if (this.data.prepare("SELECT 1 FROM execution_evidence_members WHERE reference_key=?").get(member)) {
          throw new ExecutionStoreError("execution_evidence_member_conflict");
        }
      }
      this.data.prepare("INSERT INTO execution_evidence VALUES (?,?,?,?)").run(key, generation, encoded.digest, encoded.text);
      const member = this.data.prepare("INSERT INTO execution_evidence_members VALUES (?,?)");
      for (const reference of refs) member.run(reference, key);
    })();
  }

  commitReferenceTransfer(generation: number, input: ExecutionReferenceTransfer): void {
    this.assertOwner(generation);
    const transfer = snapshotExecutionReferenceTransfer(input), encoded = encode(transfer);
    this.data.transaction(() => {
      const existing = this.data.prepare("SELECT digest FROM execution_reference_transfers WHERE id=?").get(transfer.id) as {digest: string} | undefined;
      if (existing) {if (existing.digest !== encoded.digest) throw new ExecutionStoreError("execution_transfer_conflict"); return;}
      if (!this.readLatestOwner("run", transfer.sourceRunId) || !this.readLatestOwner("run", transfer.recipientRunId)) throw new ExecutionStoreError("execution_transfer_run_missing");
      const count = this.data.prepare("SELECT count(*) AS n FROM execution_reference_transfers WHERE recipient_run_id=?").get(transfer.recipientRunId) as {n: number};
      if (count.n >= 256) throw new ExecutionStoreError("execution_transfer_capacity_exceeded");
      if (transfer.scope.kind === "references") for (const ref of transfer.scope.references) {
        const evidence = this.readExecutionEvidence(ref);
        if (!evidence || evidence.source.correlation.kind !== "run_action" || evidence.source.correlation.run.id !== transfer.sourceRunId) throw new ExecutionStoreError("execution_transfer_source_invalid");
      }
      this.data.prepare("INSERT INTO execution_reference_transfers VALUES (?,?,?,?)").run(transfer.id, transfer.recipientRunId, encoded.digest, encoded.text);
    })();
  }
  readReferenceTransfers(runId: string): readonly ExecutionReferenceTransfer[] {
    this.assertOwner(this.generation);
    return (this.data.prepare("SELECT digest,value FROM execution_reference_transfers WHERE recipient_run_id=? ORDER BY id").all(runId) as {digest: string; value: string}[]).map(row => {
      const input = JSON.parse(row.value);
      if (digest(input) !== row.digest) throw new ExecutionStoreError("execution_transfer_corrupt");
      return snapshotExecutionReferenceTransfer(input);
    });
  }
  readRunExecutionRefs(runId: string, after: string | null, limit: number): ExecutionReferencePage {
    this.assertOwner(this.generation);
    if (!Number.isInteger(limit) || limit < 1 || limit > 16 || after !== null && (typeof after !== "string" || after.length > 4096)) throw new ExecutionStoreError("execution_reference_page_invalid");
    const rows = this.data.prepare(`SELECT reference_key FROM execution_evidence WHERE reference_key > ?
      AND json_extract(value, '$.source.correlation.kind')='run_action' AND json_extract(value, '$.source.correlation.run.id')=?
      ORDER BY reference_key LIMIT ?`).all(after ?? "", runId, limit + 1) as {reference_key: string}[];
    const references = rows.slice(0, limit).map(row => {
      const [owner, kind, id, revision] = JSON.parse(row.reference_key);
      const ref = snapshotExecutionEvidenceRef({owner, kind, id, revision}, "execution");
      if (!this.readExecutionEvidence(ref)) throw new ExecutionStoreError("execution_evidence_corrupt");
      return ref;
    });
    return {references, next: rows.length > limit ? rows[limit - 1]!.reference_key : null};
  }

  readExecutionEvidence(reference: ExecutionEvidenceRef): ExecutionEvidenceRecord | null {
    this.assertOwner(this.generation);
    const key = executionEvidenceKey(snapshotExecutionEvidenceRef(reference));
    const row = this.data.prepare(`SELECT e.reference_key,e.digest,e.value FROM execution_evidence e
      JOIN execution_evidence_members m ON m.execution_key=e.reference_key WHERE m.reference_key=?`).get(key) as
      {reference_key: string; digest: string; value: string} | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as ExecutionEvidenceRecord;
    if (digest(value) !== row.digest) throw new ExecutionStoreError("execution_evidence_corrupt");
    const record = snapshotExecutionEvidence(value);
    if (executionEvidenceKey(record.ref) !== row.reference_key ||
        !evidenceMemberRefs(record).some(ref => executionEvidenceKey(ref) === key)) throw new ExecutionStoreError("execution_evidence_corrupt");
    return record;
  }

  commitCompensationAssociation(generation: number, input: CompensationAssociation): void {
    this.assertOwner(generation);
    const association = snapshotCompensationAssociation(input);
    const encoded = encode(association);
    this.data.transaction(() => {
      this.assertOwner(generation);
      const prior = this.readCompensationAssociation(association.invocation.id);
      if (prior) {
        if (!equal(prior, association)) throw new ExecutionStoreError("execution_compensation_conflict");
        return;
      }
      for (const target of association.targets) {
        const source = this.readExecutionEvidence(target.requested);
        if (!source || executionEvidenceKey(source.ref) !== executionEvidenceKey(target.execution) ||
            !equal(source.source.result, target.result) || source.source.resultRevision !== target.resultRevision ||
            !equal(source.source.correlation, target.sourceCorrelation)) {
          throw new ExecutionStoreError("execution_compensation_source_invalid");
        }
      }
      if (this.data.prepare("SELECT 1 FROM compensation_associations WHERE association_id=?").get(association.id)) {
        throw new ExecutionStoreError("execution_compensation_conflict");
      }
      this.data.prepare("INSERT INTO compensation_associations VALUES (?,?,?,?,?)").run(
        association.invocation.id, association.id, generation, encoded.digest, encoded.text);
    })();
  }

  readCompensationAssociation(invocationId: string): CompensationAssociation | null {
    this.assertOwner(this.generation);
    const row = this.data.prepare("SELECT digest,value FROM compensation_associations WHERE invocation_id=?").get(invocationId) as {digest: string; value: string} | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as CompensationAssociation;
    if (digest(value) !== row.digest || value.invocation.id !== invocationId) throw new ExecutionStoreError("execution_compensation_corrupt");
    return snapshotCompensationAssociation(value);
  }

  prepareConversationHandoff(sourceRunId: string, sessionId: string): HelarcConversationHandoff {
    this.assertOwner(this.generation);
    return this.checkpointTransaction(() => {
      const source = this.readProductRun(sourceRunId);
      const initial = this.readOwnerCommit(`${sourceRunId}:commit:0`), head = this.readLatestOwner("run", sourceRunId);
      if (!source || source.sessionId !== sessionId || initial?.kind !== "run" || head?.kind !== "run") {
        throw new ExecutionStoreError("conversation_source_unavailable");
      }
      const scopes = [{sourceRunId, scope: {kind: "public_run" as const}}, ...this.readReferenceTransfers(sourceRunId).map(({sourceRunId, scope}) => ({sourceRunId, scope}))];
      const executionScopes = [...new Map(scopes.map(scope => [digest(scope), scope])).values()];
      return {seed: source.version===4?helarcNativeConversationSeed(initial.value,head.value):helarcConversationSeed(initial.value, head.value),
        materialRefs: this.materialTransfers.visibleReferences(sourceRunId), executionScopes};
    });
  }

  admitProductRun(generation: number, admission: HelarcExecutionAdmission): void {
    this.assertOwner(generation);
    validateRetainedExecutionAdmission(admission);
    validateProtectedEnvironment(admission.commandEnvironment.environment);
    token(admission.rootRunId); token(admission.productRunId); token(admission.sessionId);
    this.checkpointTransaction(() => {
      const resolution = this.resolveAdmission(admission.rootRunId, admission.productRunId);
      if (resolution.status === "closed") throw new ExecutionStoreError("execution_admission_closed");
      const retained = this.readProductRun(admission.rootRunId);
      if (retained?.commandEnvironment.environment.digest === admission.commandEnvironment.environment.digest)
        admission = {...admission, commandEnvironment: {...admission.commandEnvironment, environment: retained.commandEnvironment.environment}};
      const encoded = this.encodeCheckpoint(admission);
      const previous = this.data.prepare("SELECT digest FROM product_admissions WHERE root_run_id=?").get(admission.rootRunId) as {digest: string} | undefined;
      if (previous) {
        if (previous.digest !== encoded.digest) throw new ExecutionStoreError("execution_admission_conflict");
        return;
      }
      const unavailable=originalPreparationLimitation(admission);
      if(unavailable)throw new TypeError(unavailable.code);
      const handoff = admission.conversationHandoff;
      if (handoff) {
        snapshotTaskInteractionSeed(handoff.seed);
        if((admission.version===4)!==isNativeTaskSeed(handoff.seed))throw new ExecutionStoreError("conversation_protocol_import_unavailable");
        if (handoff.seed.sourceRunId === admission.rootRunId) throw new ExecutionStoreError("conversation_source_invalid");
        token(handoff.recipientAgent.id); token(handoff.recipientAgent.revision);
        const original = this.prepareConversationHandoff(handoff.seed.sourceRunId, admission.sessionId);
        if (!equal(original.seed, handoff.seed) || !equal(original.materialRefs, handoff.materialRefs) ||
            !equal(original.executionScopes, handoff.executionScopes) ||
            this.readProductRun(handoff.seed.sourceRunId)!.identity.id !== admission.identity.id) {
          throw new ExecutionStoreError("conversation_handoff_changed");
        }
        // New holds and scoped grants are committed with admission, before the
        // source's lifetime can cease to protect the recipient's required data.
        for (let n = 0; n < handoff.materialRefs.length; n += 16) {
          this.materialTransfers.accept({id: `${admission.rootRunId}:conversation-materials:${n}`,
            sourceRunId: handoff.seed.sourceRunId, recipientRunId: admission.rootRunId,
            references: handoff.materialRefs.slice(n, n + 16), basis: {kind: "continuation", id: handoff.seed.digest}},
          {runId: admission.rootRunId, recipient: handoff.recipientAgent.id, purpose: HELARC_CONTROLLER_CAPABILITY});
        }
      }
      this.data.prepare("INSERT INTO product_admissions VALUES (?,?,?,0)").run(admission.rootRunId, encoded.digest, encoded.text);
      this.writeAdmissionFence(admission.rootRunId, admission.productRunId, false);
    });
  }

  resolveAdmission(rootRunId: string, intentId: string): ExecutionAdmissionResolution {
    this.assertOwner(this.generation);
    token(rootRunId); token(intentId);
    return this.resolveOriginalAdmission(rootRunId,intentId,this.readProductRun(rootRunId));
  }

  private resolveOriginalAdmission(rootRunId:string,intentId:string,basis:HelarcExecutionAdmission|null):ExecutionAdmissionResolution {
    const row = this.statement("SELECT root_run_id,intent_id,closed,digest,value FROM execution_admission_fences WHERE root_run_id=? OR intent_id=?")
      .get(rootRunId, intentId) as {root_run_id:string;intent_id:string;closed:number;digest:string;value:string} | undefined;
    if (row) {
      const value = JSON.parse(row.value);
      if (digest(value) !== row.digest || value.rootRunId !== row.root_run_id || value.intentId !== row.intent_id ||
          value.closed !== (row.closed === 1)) throw new ExecutionStoreError("execution_admission_corrupt");
      if (row.root_run_id !== rootRunId || row.intent_id !== intentId) throw new ExecutionStoreError("execution_admission_identity_conflict");
    }
    if (basis && basis.productRunId !== intentId) throw new ExecutionStoreError("execution_admission_identity_conflict");
    const initial = this.readOwnerCommit(`${rootRunId}:commit:0`);
    const accepted = initial?.kind === "run" && initial.value.admission !== null;
    if (accepted && (initial.value.state.run.id!==rootRunId||initial.value.admission!.lineage.root.id!==rootRunId))
      throw new ExecutionStoreError("execution_admission_identity_conflict");
    if (accepted && row?.closed === 1) throw new ExecutionStoreError("execution_admission_corrupt");
    return {rootRunId, intentId, status: accepted ? "accepted" : row?.closed === 1 ? "closed" : basis ? "prepared" : "unknown",
      acceptanceId: accepted ? initial.value.id : null};
  }

  readRunControl(runId:string):import("./RunExecutionControl.js").RunExecutionControl|null {
    this.assertOwner(this.generation);token(runId);
    return this.timed("run.control",()=>{
      const row=this.statement("SELECT record_id FROM execution_commits WHERE owner='run' AND owner_id=? ORDER BY revision DESC LIMIT 1")
        .get(runId) as {record_id:string}|undefined;
      if(!row)return null;
      const known=this.runControls.get(row.record_id);
      if(known)return known;
      const original=this.readOwnerCommit(row.record_id);
      if(original?.kind!=="run"||original.value.state.run.id!==runId)throw new ExecutionStoreError("execution_records_corrupt");
      const {state,control}=original.value;
      const value=Object.freeze({runId,commitId:row.record_id,revision:state.revision,
        cancelled:control.cancellation!==null||state.cancellationRequest!==null,terminal:state.settlement!==null});
      this.runControls.set(row.record_id,value);
      if(this.runControls.size>256)this.runControls.delete(this.runControls.keys().next().value!);
      return value;
    });
  }

  closeAdmission(generation: number, rootRunId: string, intentId: string): ExecutionAdmissionResolution {
    this.assertOwner(generation);
    return this.checkpointTransaction(() => {
      const result = this.resolveAdmission(rootRunId, intentId);
      if (result.status === "accepted" || result.status === "closed") return result;
      this.writeAdmissionFence(rootRunId, intentId, true);
      return {...result, status: "closed", acceptanceId: null};
    });
  }

  readTreeControl(rootRunId:string):readonly import("./RunExecutionControl.js").RunExecutionControl[] {
    this.assertOwner(this.generation);token(rootRunId);
    return this.timed("run.tree-control",()=>this.data.transaction(()=>{
      const membership=this.statement("SELECT root_run_id FROM run_tree_members WHERE run_id=?").get(rootRunId) as {root_run_id:string}|undefined;
      if(membership&&membership.root_run_id!==rootRunId)throw new ExecutionStoreError("execution_admission_identity_conflict");
      const root=this.readRunControl(rootRunId);
      if(!root)return [];
      const rows=this.statement("SELECT run_id FROM run_tree_members WHERE root_run_id=? AND run_id<>? ORDER BY run_id")
        .all(rootRunId,rootRunId) as {run_id:string}[];
      return [root,...rows.map(row=>{
        const value=this.readRunControl(row.run_id);
        if(!value)throw new ExecutionStoreError("execution_records_corrupt");
        return value;
      })];
    })());
  }

  private writeAdmissionFence(rootRunId: string, intentId: string, closed: boolean): void {
    const value = {rootRunId, intentId, closed};
    this.statement("INSERT INTO execution_admission_fences VALUES (?,?,?,?,?) ON CONFLICT(root_run_id) DO UPDATE SET closed=excluded.closed,digest=excluded.digest,value=excluded.value")
      .run(rootRunId, intentId, closed ? 1 : 0, digest(value), JSON.stringify(value));
  }

  private admissionClosed(rootRunId:string):boolean {
    const row=this.statement("SELECT root_run_id,intent_id,closed,digest,value FROM execution_admission_fences WHERE root_run_id=?")
      .get(rootRunId) as {root_run_id:string;intent_id:string;closed:number;digest:string;value:string}|undefined;
    if(!row)return false;
    const value=JSON.parse(row.value);
    if(digest(value)!==row.digest||value.rootRunId!==rootRunId||value.intentId!==row.intent_id||value.closed!==(row.closed===1))
      throw new ExecutionStoreError("execution_admission_corrupt");
    return value.closed;
  }

  readProductRun(rootRunId: string): HelarcExecutionAdmission | null {
    this.assertOwner(this.generation);
    const row = this.data.prepare("SELECT digest,value FROM product_admissions WHERE root_run_id=?").get(rootRunId) as {digest: string; value: string} | undefined;
    if (!row) return null;
    const admission = this.readCheckpoint(row) as HelarcExecutionAdmission;
    validateRetainedExecutionAdmission(admission);
    if (admission.rootRunId !== rootRunId) {
      throw new ExecutionStoreError("execution_admission_corrupt");
    }
    validateProtectedEnvironment(admission.commandEnvironment.environment);
    if (admission.conversationHandoff) snapshotTaskInteractionSeed(admission.conversationHandoff.seed);
    return admission;
  }

  listProductRuns(filter?:"file_cleanup"|"undelivered"|{rootRunId:string}): readonly HelarcExecutionDiscovery[] {
    this.assertOwner(this.generation);
    return this.data.transaction(() => {
      const select="SELECT root_run_id,delivered FROM product_admissions";
      const rows=(typeof filter==="object"?this.statement(select+" WHERE root_run_id=?").all(filter.rootRunId):
        filter==="file_cleanup"?this.statement(select+` WHERE delivered=1 AND root_run_id IN (
          SELECT COALESCE(m.root_run_id,p.value) FROM file_materials f JOIN json_each(f.value,'$.pins') p
          LEFT JOIN run_tree_members m ON m.run_id=p.value)`).all():
        filter==="undelivered"?this.statement(select+" WHERE delivered=0").all():this.statement(select).all()) as {root_run_id:string;delivered:number}[];
      return rows.flatMap(row => {
        const admission = this.readProductRun(row.root_run_id)!;
        const head = this.readRunControl(row.root_run_id);
        const resolution = this.resolveOriginalAdmission(admission.rootRunId, admission.productRunId,admission);
        if(row.delivered!==0 && (row.delivered!==1||!head?.terminal||resolution.status!=="accepted"))
          throw new ExecutionStoreError("execution_admission_corrupt");
        if (resolution.status === "closed") return [];
        return [{admission, admitted: resolution.status === "accepted", terminal: head?.terminal??false,
          delivered: row.delivered === 1, revision: head?.revision??-1}];
      });
    })();
  }

  discoverProductWork(delivery:"file_cleanup"|"undelivered"):readonly import("./HelarcExecutionAdmission.js").ProductWorkSummary[] {
    return this.listProductRuns(delivery).map(({admission,...state})=>({...state,rootRunId:admission.rootRunId,
      productRunId:admission.productRunId,sessionId:admission.sessionId,title:admission.task.input.prompt.slice(0,160),
      resumeLimitation:state.terminal?null:originalPreparationLimitation(admission)}));
  }

  commitProductDelivery(generation: number, rootRunId: string): void {
    this.assertOwner(generation);
    this.data.transaction(() => {
      const [original]=this.listProductRuns({rootRunId});
      if (!original?.admitted || !original.terminal) {
        throw new ExecutionStoreError("execution_delivery_not_terminal");
      }
      if(original.delivered)return;
      const tree=this.readRunTree(rootRunId);
      if(!tree)throw new ExecutionStoreError("execution_records_corrupt");
      this.data.prepare("UPDATE product_admissions SET delivered=1 WHERE root_run_id=?").run(rootRunId);
      for(const member of tree.members)this.contextMaterials.releaseRun(member.head.state.run.id);
    })();
  }

  /** Product delivery ends retention obligations only for settled, known effects. */
  finalizeFileMaterials(generation: number, rootRunId: string, after: string | null, at: string) {
    this.assertOwner(generation);
    return this.data.transaction(() => {
      const admission = this.data.prepare("SELECT delivered FROM product_admissions WHERE root_run_id=?").get(rootRunId) as {delivered: number} | undefined;
      const tree = this.readRunTree(rootRunId);
      if (admission?.delivered !== 1 || !tree || tree.members.some(member => member.head.state.settlement === null)) {
        throw new ExecutionStoreError("execution_material_obligations_unsettled");
      }
      for (const member of tree.members) {
        const runId = member.head.state.run.id;
        const actions = this.data.prepare("SELECT DISTINCT action_id FROM action_records WHERE run_id=?").all(runId) as {action_id: string}[];
        if (actions.some(({action_id}) => {
          const records = this.readAction(runId, action_id), settlement = records.settlement?.settlement;
          return records.attempts.length > 0 && (!settlement || settlement.effectCertainty === "unknown" || settlement.effectCertainty === "partial");
        })) return {records: [], next: null};
        if (this.readProcesses(runId).some(process => process.snapshot.phase !== "settled" || process.snapshot.containment.disposition !== "empty")) return {records: [], next: null};
      }
      return this.fileMaterials.finalizePage(tree.members.map(member => member.head.state.run.id), after, at, material => {
        const original = this.readAction(material.preparation.runId, material.preparation.attempt.action.id);
        const settlement = original.settlement?.settlement;
        // Unknown effects remain an unresolved owner obligation even after a terminal Run.
        if (!settlement || settlement.effectCertainty === "unknown" || settlement.effectCertainty === "partial") return false;
        return material.state !== "staging" || settlement.effectCertainty === "none";
      });
    })();
  }

  /** Pins are derived from acknowledged owners, never a second mutable ledger. */
  listRetentionPins(): readonly import("./ExecutionStoreProtocol.js").ExecutionRetentionPin[] {
    this.assertOwner(this.generation);
    return this.data.transaction(() => {
      const pins: import("./ExecutionStoreProtocol.js").ExecutionRetentionPin[] = [];
      for (const ownerId of this.activityHandoffs.retainedRuns()) pins.push({ownerId,reason:"activity_handoff"});
      for (const ownerId of this.materialCustody.retainedRuns()) pins.push({ownerId,reason:"context_material"});
      for (const ownerId of this.protocolExecution.retainedRuns()) pins.push({ownerId,reason:"protocol_evidence"});
      for (const ownerId of this.contextMaterials.retainedOwners()) pins.push({ownerId, reason: "context_material"});
        for (const ownerId of this.fileMaterials.pinnedOwners()) pins.push({ownerId, reason: "file_material"});
      const owners = this.data.prepare("SELECT DISTINCT owner_id FROM execution_commits WHERE owner='run'").all() as {owner_id: string}[];
      for (const {owner_id} of owners) {
        const retained = this.readLatestOwner("run", owner_id);
        if (retained?.kind === "run" && !["completed", "cancelled", "failed"].includes(retained.value.state.status)) {
          pins.push({ownerId: owner_id, reason: "unfinished_run"});
        }
      }
      for (const item of this.listProductRuns("undelivered")) {
        if (item.terminal && !item.delivered) pins.push({ownerId: item.admission.rootRunId, reason: "undelivered_result"});
      }
      const runs = this.data.prepare("SELECT DISTINCT run_id FROM process_records").all() as {run_id: string}[];
      for (const {run_id} of runs) for (const process of this.readProcesses(run_id)) {
        if (process.snapshot.containment.disposition !== "empty" || process.snapshot.output.persistence === "pending") {
          pins.push({ownerId: process.input.executionId, reason: "unsettled_process"});
        }
      }
      return pins;
    })();
  }

  commitHookInvocation(generation: number, checkpoint: AgentHookInvocationCheckpoint): void {
    this.assertOwner(generation);
    const encoded = encode(checkpoint);
    this.data.transaction(() => {
      const previous = this.readHookInvocation(checkpoint.id);
      validateAgentHookCheckpoint(checkpoint, previous);
      const stage = Number(checkpoint.outcome !== null);
      const row = this.data.prepare("SELECT digest FROM hook_records WHERE id=? AND stage=?").get(checkpoint.id, stage) as {digest: string} | undefined;
      if (row) {
        if (row.digest !== encoded.digest) throw new ExecutionStoreError("execution_hook_record_conflict");
        return;
      }
      this.data.prepare("INSERT INTO hook_records VALUES (?,?,?,?,?)").run(checkpoint.id, stage, generation, encoded.digest, encoded.text);
    })();
  }

  readHookInvocation(id: string): AgentHookInvocationCheckpoint | null {
    this.assertOwner(this.generation);
    const rows = this.data.prepare("SELECT * FROM hook_records WHERE id=? ORDER BY stage").all(id) as {id: string; stage: number; digest: string; value: string}[];
    let previous: AgentHookInvocationCheckpoint | null = null;
    for (const row of rows) {
      const checkpoint = JSON.parse(row.value) as AgentHookInvocationCheckpoint;
      if (encode(checkpoint).digest !== row.digest || checkpoint.id !== row.id || Number(checkpoint.outcome !== null) !== row.stage) {
        throw new ExecutionStoreError("execution_hook_records_corrupt");
      }
      validateAgentHookCheckpoint(checkpoint, previous);
      previous = checkpoint;
    }
    return previous;
  }

  listUnsettledHooks(): readonly AgentHookInvocationCheckpoint[] {
    this.assertOwner(this.generation);
    const rows = this.data.prepare("SELECT id FROM hook_records WHERE stage=0 AND id NOT IN (SELECT id FROM hook_records WHERE stage=1)").all() as {id: string}[];
    return rows.map(row => this.readHookInvocation(row.id)!);
  }

  commitProcess(generation: number, checkpoint: ProcessCheckpoint): void {
    this.assertOwner(generation);
    validateProtectedEnvironment(checkpoint.input.environment);
    this.data.transaction(() => {
      const rows = this.data.prepare("SELECT * FROM process_records WHERE execution_id=? ORDER BY revision")
        .all(checkpoint.input.executionId) as ProcessRow[];
      const previous = this.decodeProcessRecords(rows);
      // Safe-storage encryption is randomized. Keep one immutable sealed value
      // for the same environment identity, including acknowledgement replay.
      if (previous?.input.environment.digest === checkpoint.input.environment.digest)
        checkpoint = {...checkpoint, input: {...checkpoint.input, environment: previous.input.environment}};
      const encoded = encode(checkpoint);
      const replay = rows.find(row => row.revision === checkpoint.revision);
      if (replay) {
        if (replay.digest !== encoded.digest) throw new ExecutionStoreError("execution_process_record_conflict");
        return;
      }
      validateProcessCheckpoint(checkpoint, previous);
      for (const view of checkpoint.materialViews.slice(previous?.materialViews.length ?? 0)) {
        const material=projectProcessOutputMaterial(checkpoint,view);
        this.contextMaterials.publishChunks(material.description,material.texts,checkpoint.input.runId);
      }
      this.data.prepare("INSERT INTO process_records VALUES (?,?,?,?,?,?)").run(checkpoint.input.executionId,
        checkpoint.input.runId, checkpoint.revision, generation, encoded.digest, encoded.text);
    })();
  }

  commitShellSession(generation: number, commit: ShellSessionCommit): void {
    this.assertOwner(generation);
    const encoded = encode(commit);
    this.data.transaction(() => {
      const previous = this.readShellSession(commit.runId);
      const replay = this.data.prepare("SELECT digest FROM shell_sessions WHERE run_id=? AND revision=?")
        .get(commit.runId, commit.after.revision) as {digest: string} | undefined;
      if (replay) {
        if (replay.digest !== encoded.digest) throw new ExecutionStoreError("execution_shell_session_conflict");
        return;
      }
      validateShellSessionCommit(commit, previous);
      this.data.prepare("INSERT INTO shell_sessions VALUES (?,?,?,?,?)")
        .run(commit.runId, commit.after.revision, generation, encoded.digest, encoded.text);
    })();
  }

  readShellSession(runId: string): ShellSessionCommit | null {
    this.assertOwner(this.generation);
    const rows = this.data.prepare("SELECT * FROM shell_sessions WHERE run_id=? ORDER BY revision").all(runId) as
      {run_id: string; revision: number; digest: string; value: string}[];
    let previous: ShellSessionCommit | null = null;
    for (const row of rows) {
      const value = JSON.parse(row.value) as ShellSessionCommit;
      if (encode(value).digest !== row.digest || value.runId !== runId || value.after.revision !== row.revision) {
        throw new ExecutionStoreError("execution_shell_session_corrupt");
      }
      validateShellSessionCommit(value, previous);
      previous = value;
    }
    return previous;
  }

  readProcesses(runId: string): readonly ProcessCheckpoint[] {
    this.assertOwner(this.generation);
    const rows = this.data.prepare("SELECT * FROM process_records WHERE run_id=? ORDER BY execution_id,revision").all(runId) as ProcessRow[];
    const groups = new Map<string, ProcessRow[]>();
    for (const row of rows) {
      const group = groups.get(row.execution_id) ?? [];
      group.push(row); groups.set(row.execution_id, group);
    }
    return [...groups.values()].map(group => this.decodeProcessRecords(group)!);
  }

  private decodeProcessRecords(rows: readonly ProcessRow[]): ProcessCheckpoint | null {
    let previous: ProcessCheckpoint | null = null;
    for (const row of rows) {
      const value = JSON.parse(row.value) as ProcessCheckpoint;
      validateProtectedEnvironment(value.input.environment);
      if (encode(value).digest !== row.digest || value.input.runId !== row.run_id ||
          value.input.executionId !== row.execution_id || value.revision !== row.revision) throw new ExecutionStoreError("execution_process_records_corrupt");
      validateProcessCheckpoint(value, previous);
      previous = value;
    }
    return previous;
  }

  readReceipt(recordId: string): ExecutionRecordReceipt | null {
    this.assertOwner(this.generation);
    const row = this.row(recordId);
    if (!row) return null;
    this.decode(row);
    return receipt(row);
  }

  readAction(runId: string, actionId: string): ActionRecoveryRecords {
    this.assertOwner(this.generation);
    token(runId); token(actionId);
    const rows = this.data.prepare("SELECT * FROM action_records WHERE run_id=? AND action_id=? ORDER BY sequence").all(runId, actionId) as StoredActionRow[];
    const preparations: ActionRecoveryRecords["preparations"][number][] = [];
    const attempts: { recordId: string; intent: Extract<ActionOwnerRecord, { kind: "dispatch_intent" }>["value"]; result: Extract<ActionOwnerRecord, { kind: "attempt_result" }>["value"] | null; retry: Extract<ActionOwnerRecord, {kind: "retry"}>["value"] | null }[] = [];
    let settlement: ActionRecoveryRecords["settlement"] = null;
    let preparedAction: ActionRecoveryRecords["preparedAction"] = null;
    for (const row of rows) {
      const record = this.decode(row);
      switch (record.kind) {
        case "prepared_action":
          if (preparedAction) throw new ExecutionStoreError("execution_records_corrupt");
          preparedAction = record.value;
          break;
        case "preparation": preparations.push({ recordId: row.record_id, value: record.value }); break;
        case "dispatch_intent": attempts.push({ recordId: row.record_id, intent: record.value, result: null, retry: null }); break;
        case "attempt_result": {
          const attempt = attempts.find(value => value.recordId === record.value.intentRecordId);
          if (!attempt || attempt.result) throw new ExecutionStoreError("execution_records_corrupt");
          attempt.result = record.value;
          break;
        }
        case "retry": {
          const attempt = attempts.find(value => value.recordId === record.value.intentRecordId);
          if (!attempt || !attempt.result || attempt.retry) throw new ExecutionStoreError("execution_records_corrupt");
          attempt.retry = record.value;
          break;
        }
        case "settlement":
          if (settlement) throw new ExecutionStoreError("execution_records_corrupt");
          settlement = record.value;
      }
    }
    return { preparedAction, preparations, attempts, settlement };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.contentCache.clear(); this.contentEncoder.clear(); this.statements.clear(); this.readContext = null;
    try { this.data.close(); } finally { this.ownership.close(); }
  }

  commitOwner(generation: number, commit: ExecutionOwnerCommit): {recordId: string; revision: number} {
    this.assertOwner(generation);
    if (commit.kind === "run" && this.data.prepare("SELECT 1 FROM run_tree_members WHERE run_id=?").get(commit.value.state.run.id)) {
      throw new ExecutionStoreError("execution_coordinated_commit_required");
    }
    return this.commitOwnerRecord(generation, commit);
  }

  commitRunTree(generation: number, input: RunTreeCommit): RunTreeCommitReceipt {
    return this.withContentScope(() => this.commitRunTreeRecord(generation, input));
  }

  private commitRunTreeRecord(generation: number, input: RunTreeCommit): RunTreeCommitReceipt {
    this.assertOwner(generation);
    const encoded = this.encodeCheckpoint(input);
    const commit = encoded.value;
    const rootRunId = commit.checkpoint.input.rootRunId;
    token(rootRunId); token(commit.id);
    return this.checkpointTransaction(() => {
      this.assertOwner(generation);
      const recorded = this.readRunTreeCommit(commit.id);
      if (recorded) {
        if (!equal(recorded, commit)) throw new ExecutionStoreError("execution_record_conflict");
        return treeReceipt(recorded);
      }
      const previous = this.readLatestRunTree(rootRunId);
      if (!previous && this.admissionClosed(rootRunId)) throw new ExecutionStoreError("execution_admission_closed");
      if ((previous?.revision ?? null) !== commit.expectedRevision) throw new ExecutionStoreError("execution_commit_revision_stale");
      const memberIds = new Set((this.statement("SELECT run_id FROM run_tree_members WHERE root_run_id=?").all(rootRunId) as {run_id: string}[]).map(row => row.run_id));
      for (const run of commit.runs) {
        const runId = run.state.run.id;
        const membership = this.statement("SELECT root_run_id FROM run_tree_members WHERE run_id=?").get(runId) as {root_run_id: string} | undefined;
        if (membership && membership.root_run_id !== rootRunId) invalidReference();
        if (this.readOwnerCommit(run.id)) throw new ExecutionStoreError("execution_partial_tree_commit");
        this.commitOwnerRecord(generation, {kind: "run", value: run});
        memberIds.add(runId);
      }
      const changes = new Map(commit.runs.map(run => [run.state.run.id, run]));
      const members = [...memberIds].map(runId => {
        const changed = changes.get(runId);
        if (!changed) return this.readTreeMembers([runId])[0]!;
        const initial = changed.admission === null ? this.readOwnerCommit(`${runId}:commit:0`) : null;
        const admission = changed.admission ?? (initial?.kind === "run" ? initial.value.admission : null);
        if (!admission) invalidReference();
        return {admission, head: changed};
      });
      validateRunTreeCommit(commit, previous, members);
      // Publication must not create a recovery basis that the bounded reader
      // cannot hydrate, even when each individual member fits on its own.
      this.contentEncoder.pack({commit, members}, this.contentScope);
      this.statement("INSERT INTO run_tree_commits VALUES(?,?,?,?,?,?)").run(commit.id, rootRunId,
        commit.revision, generation, encoded.digest, encoded.text);
      for (const runId of memberIds) this.statement("INSERT OR IGNORE INTO run_tree_members VALUES(?,?)").run(runId, rootRunId);
      return treeReceipt(commit);
    });
  }

  readRunTreeCommit(id: string): RunTreeCommit | null {
    this.assertOwner(this.generation);
    const retained = this.readContext?.trees.get(id);
    if (retained) return retained;
    const row = this.statement("SELECT root_run_id,revision,digest,value FROM run_tree_commits WHERE record_id=?").get(id) as
      {root_run_id: string; revision: number; digest: string; value: string} | undefined;
    if (!row) return null;
    const value = this.readCheckpoint(row) as RunTreeCommit;
    if (value.id !== id || value.revision !== row.revision ||
        value.checkpoint.input.rootRunId !== row.root_run_id) throw new ExecutionStoreError("execution_records_corrupt");
    this.readContext?.trees.set(id, value);
    return value;
  }

  readLatestRunTree(rootRunId: string): RunTreeCommit | null {
    this.assertOwner(this.generation);
    const row = this.statement("SELECT record_id FROM run_tree_commits WHERE root_run_id=? ORDER BY revision DESC LIMIT 1").get(rootRunId) as {record_id: string} | undefined;
    return row ? this.readRunTreeCommit(row.record_id) : null;
  }

  readRunTreeMembers(rootRunId: string, cursor: import("./RunTreeMembership.js").RunTreeMembershipCursor | null,
    limit: number): import("./RunTreeMembership.js").RunTreeMembershipPage {
    this.assertOwner(this.generation);
    token(rootRunId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || cursor &&
        (cursor.rootRunId !== rootRunId || !Number.isSafeInteger(cursor.after) || cursor.after < 0 ||
         !Number.isSafeInteger(cursor.through) || cursor.through < cursor.after)) {
      throw new ExecutionStoreError("execution_membership_cursor_invalid");
    }
    return this.checkpointTransaction(() => {
      const through = cursor?.through ?? (this.statement("SELECT COALESCE(MAX(rowid),0) AS last FROM run_tree_members WHERE root_run_id=?")
        .get(rootRunId) as {last: number}).last;
      const rows = this.statement("SELECT rowid AS sequence,run_id FROM run_tree_members WHERE root_run_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?")
        .all(rootRunId, cursor?.after ?? 0, through, limit + 1) as {sequence: number; run_id: string}[];
      const page = rows.slice(0, limit);
      return {runIds: page.map(row => row.run_id), next: rows.length > limit
        ? {rootRunId, through, after: page.at(-1)!.sequence} : null};
    });
  }

  readRunTree(rootRunId: string): RunTreeRecoveryRecords | null {
    this.assertOwner(this.generation);
    return this.checkpointTransaction(() => {
      const commit = this.readLatestRunTree(rootRunId);
      if (!commit) return null;
      const previous = commit.expectedRevision === null ? null : this.readRunTreeCommit(`${rootRunId}:tree_commit:${commit.expectedRevision}`);
      const rows = this.statement("SELECT run_id FROM run_tree_members WHERE root_run_id=? ORDER BY run_id").all(rootRunId) as {run_id: string}[];
      const members = this.readTreeMembers(rows.map(row => row.run_id));
      validateRunTreeCommit(commit, previous, members);
      return {commit, members};
    });
  }

  private readTreeMembers(runIds: readonly string[]): RetainedRunTreeMember[] {
    return runIds.map(runId => {
      const initial = this.readOwnerCommit(`${runId}:commit:0`);
      const head = this.readLatestOwner("run", runId);
      if (initial?.kind !== "run" || initial.value.admission === null || head?.kind !== "run") invalidReference();
      return {admission: initial.value.admission, head: head.value};
    });
  }

  private commitOwnerRecord(generation: number, commit: ExecutionOwnerCommit): {recordId: string; revision: number} {
    this.assertOwner(generation);
    const encoded = this.encodeCheckpoint(commit);
    const value = encoded.value;
    const ownerId = value.kind === "run" ? value.value.state.run.id : value.value.state.compositeId;
    const {id, expectedRevision, state} = value.value;
    token(id); token(ownerId);
    if (id !== `${ownerId}:commit:${state.revision}` || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        (expectedRevision === null ? state.revision !== 0 : state.revision !== expectedRevision + 1)) {
      throw new ExecutionStoreError("execution_commit_revision_invalid");
    }
    return this.checkpointTransaction(() => {
      this.assertOwner(generation);
      const existing = this.readOwnerCommit(id);
      if (existing) {
        if (!equal(existing, value)) throw new ExecutionStoreError("execution_record_conflict");
        return {recordId: id, revision: state.revision};
      }
      const previous = this.readLatestOwner(value.kind, ownerId);
      if(value.kind==="run"&&!previous&&this.admissionClosed(ownerId))throw new ExecutionStoreError("execution_admission_closed");
      if ((previous?.value.state.revision ?? null) !== expectedRevision) throw new ExecutionStoreError("execution_commit_revision_stale");
      if (previous?.kind === "run" && ["completed", "failed", "cancelled"].includes(previous.value.state.status) ||
          previous?.kind === "composite" && previous.value.state.terminal !== null) {
        throw new ExecutionStoreError("execution_owner_already_settled");
      }
      if (value.kind === "run") {
        if (expectedRevision === null ? value.value.admission === null : value.value.admission !== null) {
          throw new ExecutionStoreError("execution_run_admission_invalid");
        }
        if (value.value.admission && !value.value.admission.delegationRequest) {
          const handoff = this.readProductRun(ownerId)?.conversationHandoff;
          if (handoff && (!equal(value.value.admission.modelInteractionSeed, handoff.seed) ||
              !equal(value.value.state.startingAgent, handoff.recipientAgent))) {
            throw new ExecutionStoreError("conversation_admission_binding_mismatch");
          }
        }
        if (value.value.control.activeAgent.id !== value.value.state.activeAgent.id ||
            value.value.control.activeAgent.revision !== value.value.state.activeAgent.revision) invalidReference();
        const {control, state} = value.value;
        this.protocolExecution.assertRunItems(ownerId,state.items);
        if (!equal(control.instructionBinding.ref, state.activeInstructionBinding) ||
            !equal(control.instructionBinding.agent, state.activeAgent) ||
            !equal(control.instructionBinding.instructions, control.instructions.ref)) invalidReference();
        if (previous?.kind === "run") {
          const before = previous.value.state;
          if (state.items.length < before.items.length ||
              !equal(state.items.slice(0, before.items.length), before.items) ||
              state.taskId !== before.taskId || state.startedAt !== before.startedAt || state.deadlineAt !== before.deadlineAt) invalidReference();
        }
        this.protocolExecution.acceptRunItems(ownerId,state.items.slice(previous?.kind==="run"?previous.value.state.items.length:0));
      } else if (previous?.kind === "composite") {
        if (value.value.runId !== previous.value.runId || !equal(value.value.definition, previous.value.definition) ||
            !equal(value.value.input, previous.value.input) || value.value.startedAt !== previous.value.startedAt) invalidReference();
        for (const request of previous.value.requests) {
          const retained = value.value.requests.find(entry => entry.nodeId === request.nodeId && entry.instance === request.instance);
          if (!retained || !equal(retained, request)) invalidReference();
        }
        for (const node of previous.value.state.nodes) {
          if (node.lifecycle !== "settled") continue;
          const retained = value.value.state.nodes.find(entry => entry.nodeId === node.nodeId && entry.instance === node.instance);
          if (!retained || !equal(retained, node)) invalidReference();
        }
      }
      this.statement("INSERT INTO execution_commits VALUES(?,?,?,?,?,?,?)").run(id, value.kind, ownerId,
        state.revision, generation, encoded.digest, encoded.text);
      if (value.kind === "run") {
        const lifetime=runActivityLifetime(ownerId);
        this.activityHandoffs.command({kind:"register_fact_source",source:lifetime.source});
        if(["completed","failed","cancelled"].includes(value.value.state.status))this.activityHandoffs.command({kind:"publish_fact",fact:{
          id:lifetime.closedFactId,sourceId:lifetime.source.id,ref:{owner:"runtime",kind:"run_commit",id,revision:String(state.revision)}}});
        const before = previous?.kind === "run" ? previous.value.state.items.length : 0;
        for (const material of projectContextMaterials(value.value, before)) this.contextMaterials.publish(material, ownerId);
        const request = value.value.admission?.delegationRequest;
        if (value.value.admission && !request) {
          const admission = this.readProductRun(ownerId), handoff = admission?.conversationHandoff;
          if (handoff) for (const [index, scope] of handoff.executionScopes.entries()) {
            this.commitReferenceTransfer(generation, {id: `${ownerId}:conversation-execution:${index}`,
              ...scope, recipientRunId: ownerId, basis: {owner: "helarc", kind: "conversation_handoff", id: ownerId, revision: handoff.seed.digest},
              acceptedAt: admission!.createdAt});
          }
        }
        if (request) {
          const taskInput = request.task.input as {material_refs?: unknown} | null;
          const refs = snapshotContextMaterialRefs(taskInput?.material_refs ?? []);
          if (refs.length) this.materialTransfers.accept({id: `${request.ref.id}:materials`, sourceRunId: request.origin.parent.run.id,
            recipientRunId: ownerId, references: refs, basis: {kind: "assignment", id: request.ref.id}});
          if (request.continuation) {
            this.materialTransfers.inherit({id:`${request.ref.id}:continuation-materials`,sourceRunId:request.continuation.sourceChild.id,
              recipientRunId:ownerId,basis:{kind:"continuation",id:request.ref.id}});
          }
        }
        if (value.value.state.status === "completed" && !(previous?.kind === "run" && previous.value.state.status === "completed")) {
          const output = value.value.state.finalOutput as {materialRefs?: unknown} | null;
          const refs = snapshotContextMaterialRefs(output?.materialRefs ?? []);
          const initial = this.readOwnerCommit(`${ownerId}:commit:0`);
          const delegation = initial?.kind === "run" ? initial.value.admission?.delegationRequest : null;
          if (refs.length && delegation) this.materialTransfers.accept({id: `${ownerId}:result-materials`, sourceRunId: ownerId,
            recipientRunId: delegation.origin.parent.run.id, references: refs, basis: {kind: "result", id: value.value.state.settlementCause.ref.id}});
        }
      }
      return {recordId: id, revision: state.revision};
    });
  }

  readOwnerCommit(id: string): ExecutionOwnerCommit | null {
    this.assertOwner(this.generation);
    const retained = this.readContext?.owners.get(id);
    if (retained) return retained;
    const row = this.statement("SELECT digest,value FROM execution_commits WHERE record_id=?").get(id) as {digest: string; value: string} | undefined;
    if (!row) return null;
    const value = this.readCheckpoint(row) as ExecutionOwnerCommit;
    if (value.value.id !== id) throw new ExecutionStoreError("execution_records_corrupt");
    if(value.kind==="run")this.protocolExecution.assertRunItems(value.value.state.run.id,value.value.state.items);
    this.readContext?.owners.set(id, value);
    return value;
  }

  readLatestOwner(owner: "run" | "composite", ownerId: string): ExecutionOwnerCommit | null {
    this.assertOwner(this.generation);
    const row = this.statement("SELECT record_id FROM execution_commits WHERE owner=? AND owner_id=? ORDER BY revision DESC LIMIT 1").get(owner, ownerId) as {record_id: string} | undefined;
    return row ? this.readOwnerCommit(row.record_id) : null;
  }

  private validateActionReferences(record: ActionOwnerRecord, runId: string, actionId: string): void {
    const settled = this.row(recordKey("settlement", runId, actionId, actionId));
    if (settled) throw new ExecutionStoreError("execution_action_already_settled");
    switch (record.kind) {
      case "prepared_action":
      case "preparation": {
        const value = record.value;
        if (!Number.isSafeInteger(value.limits.maxAttempts) || value.limits.maxAttempts < 1 ||
            !Number.isFinite(Date.parse(value.limits.deadlineAt))) invalidReference();
        const first = this.data.prepare("SELECT * FROM action_records WHERE run_id=? AND action_id=? AND kind='preparation' ORDER BY sequence LIMIT 1").get(runId, actionId) as StoredActionRow | undefined;
        if (first) {
          const prior = this.decode(first) as Extract<ActionOwnerRecord, {kind: "preparation"}>;
          if (!equal(value.limits, prior.value.limits) || !equal(value.binding, prior.value.binding) ||
              !equal(value.prepared, prior.value.prepared)) invalidReference();
        }
        const initial = this.row(recordKey("prepared_action", runId, actionId, actionId));
        if (initial) {
          const prior = this.decode(initial) as Extract<ActionOwnerRecord, {kind: "prepared_action"}>;
          if (!equal(value.limits, prior.value.limits) || !equal(value.binding, prior.value.binding) ||
              !equal(value.registration, prior.value.registration) || !equal(value.prepared, prior.value.prepared)) invalidReference();
        }
        if (value.prepared.subject.parentRunAction?.run.id !== undefined && value.prepared.subject.parentRunAction.run.id !== runId) invalidReference();
        if (!equal(value.binding.invocation, value.prepared.subject.operationInvocation) ||
            !equal(value.binding.binding, value.prepared.subject.binding) ||
            value.registration.registrationFingerprint !== value.prepared.subject.executorRegistrationFingerprint) invalidReference();
        break;
      }
      case "dispatch_intent": {
        const preparation = this.requireRecord(record.value.preparationRecordId, "preparation", runId, actionId).value;
        const request = record.value.request;
        if (!equal(request.invocation, preparation.prepared.invocation) ||
            request.deadlineAt !== preparation.limits.deadlineAt || request.attempt.ordinal > preparation.limits.maxAttempts ||
            !equal(request.executor, preparation.registration.executor) ||
            request.actionRegistrationFingerprint !== preparation.registration.registrationFingerprint ||
            request.attempt.dispatchPlanFingerprint !== preparation.dispatchPlanFingerprint) invalidReference();
        if (!Number.isSafeInteger(request.attempt.ordinal) || request.attempt.ordinal < 1) invalidReference();
        const prior = this.data.prepare("SELECT COUNT(*) AS count FROM action_records WHERE run_id=? AND action_id=? AND kind='dispatch_intent'").get(runId, actionId) as { count: number };
        if (request.attempt.ordinal !== prior.count + 1) invalidReference();
        const ledger = CanonicalActionLedger.restoreDispatch(record.value.ledger).getSnapshot();
        if (ledger.action.id !== actionId || ledger.attempts.length !== request.attempt.ordinal ||
            ledger.activeDispatchClaim?.attempt.id !== request.attempt.id ||
            ledger.activeDispatchClaim.planFingerprint !== preparation.dispatchPlanFingerprint ||
            !equal(ledger.subjects.at(-1), preparation.prepared.subject)) invalidReference();
        if (prior.count > 0) {
          const previousRow = this.data.prepare("SELECT * FROM action_records WHERE run_id=? AND action_id=? AND kind='dispatch_intent' ORDER BY sequence DESC LIMIT 1").get(runId, actionId) as StoredActionRow;
          const previous = this.decode(previousRow) as Extract<ActionOwnerRecord, { kind: "dispatch_intent" }>;
          this.requireRecord(recordKey("attempt_result", runId, actionId, previous.value.request.attempt.id), "attempt_result", runId, actionId);
          const retry = this.requireRecord(recordKey("retry", runId, actionId, previous.value.request.attempt.id), "retry", runId, actionId).value;
          if (retry.decision.status !== "retry" || !equal(ledger.attempts.slice(0, -1), previous.value.ledger.attempts)) invalidReference();
        }
        break;
      }
      case "attempt_result": {
        const intent = this.requireRecord(record.value.intentRecordId, "dispatch_intent", runId, actionId).value;
        if (!equal(record.value.result.attempt, intent.request.attempt)) invalidReference();
        if (record.value.reconciliation) {
          if (record.value.reconciliation.evidenceRefs.length === 0) invalidReference();
          for (const ref of record.value.reconciliation.evidenceRefs) token(ref);
        }
        break;
      }
      case "retry": {
        const value = record.value;
        const intent = this.requireRecord(value.intentRecordId, "dispatch_intent", runId, actionId).value;
        const preparation = this.requireRecord(intent.preparationRecordId, "preparation", runId, actionId).value;
        const result = this.requireRecord(recordKey("attempt_result", runId, actionId, value.attempt.id), "attempt_result", runId, actionId).value.result;
        if (!equal(value.limits, preparation.limits) || value.attempt.id !== intent.request.attempt.id ||
            value.attempt.action.id !== actionId || value.attempt.ordinal !== intent.request.attempt.ordinal ||
            value.remainingAttempts !== value.limits.maxAttempts - value.attempt.ordinal || value.remainingAttempts < 1 ||
            !Number.isFinite(Date.parse(value.decidedAt)) ||
            (result.status === "sandbox_unavailable" ? result.effectState !== "none" :
              result.outcome.status !== "failed" || result.outcome.effectState !== "none" || !result.outcome.failure.retryable)) invalidReference();
        if (value.decision.status === "retry") {
          if (!Number.isSafeInteger(value.decision.delayMs) || value.decision.delayMs < 0 || value.notBefore === null ||
              Date.parse(value.notBefore) !== Date.parse(value.decidedAt) + value.decision.delayMs) invalidReference();
          token(value.decision.decisionRecordId);
        } else if (value.decision.status !== "stop" || value.notBefore !== null) invalidReference();
        else token(value.decision.code);
        break;
      }
      case "settlement": {
        const value = record.value;
        if (value.settlement.ref.action.id !== actionId ||
            !equal(value.binding.invocation, value.settlement.operationInvocation) ||
            !equal(value.binding.binding, value.settlement.binding) ||
            (value.prepared && value.prepared.subject.ref.action.id !== actionId)) invalidReference();
        if (value.sandbox) {
          const result = this.requireRecord(recordKey("attempt_result", runId, actionId, value.sandbox.attempt.id), "attempt_result", runId, actionId).value;
          if (!equal(result.result, value.sandbox)) invalidReference();
        }
        if (value.reconciliation) {
          const reconciliation = value.reconciliation;
          const intent = this.requireRecord(reconciliation.intentRecordId, "dispatch_intent", runId, actionId).value;
          const preparation = this.requireRecord(intent.preparationRecordId, "preparation", runId, actionId).value;
          if (!equal(value.prepared, preparation.prepared) ||
              !value.settlement.attempts.some(attempt => attempt.id === intent.request.attempt.id)) invalidReference();
          for (const ref of reconciliation.evidenceRefs) token(ref);
          if (reconciliation.status === "unknown") {
            if (value.sandbox !== null || value.settlement.status !== "unknown_effect" ||
                value.settlement.effectCertainty !== "unknown" || !value.settlement.reconciliationRequired ||
                reconciliation.code !== value.settlement.causeRef) invalidReference();
            token(reconciliation.code!);
          } else if (reconciliation.status !== "settled" || value.sandbox === null || reconciliation.evidenceRefs.length === 0) invalidReference();
        }
        break;
      }
    }
  }

  private requireRecord<K extends ActionOwnerRecord["kind"]>(id: string, kind: K, runId: string, actionId: string): Extract<ActionOwnerRecord, { kind: K }> {
    const row = this.row(id);
    if (!row || row.kind !== kind || row.run_id !== runId || row.action_id !== actionId) invalidReference();
    return this.decode(row!) as Extract<ActionOwnerRecord, { kind: K }>;
  }
  private row(id: string): StoredActionRow | undefined {
    return this.data.prepare("SELECT * FROM action_records WHERE record_id=?").get(id) as StoredActionRow | undefined;
  }
  private decode(row: StoredActionRow): ActionOwnerRecord {
    const value = JSON.parse(row.value) as ActionOwnerRecord;
    const identity = actionRecordIdentity(value);
    if (digest(value) !== row.digest || identity.recordId !== row.record_id ||
        identity.runId !== row.run_id || identity.actionId !== row.action_id || value.kind !== row.kind) {
      throw new ExecutionStoreError("execution_records_corrupt");
    }
    return value;
  }
  private assertOwner(generation: number): void {
    if (this.closed) throw new ExecutionStoreError("execution_store_closed");
    if (generation !== this.generation) throw new ExecutionStoreError("execution_owner_stale");
    if (this.readContext?.ownerConfirmed) {this.contentStatistics.add("owner.readReuses"); return;}
    this.contentStatistics.add("owner.reads");
    const row = this.statement("SELECT generation FROM store WHERE id=1").get() as { generation: number };
    if (generation !== this.generation || row.generation !== generation) throw new ExecutionStoreError("execution_owner_stale");
    if (this.readContext) this.readContext.ownerConfirmed = true;
  }
  stageContent(generation: number, blocks: readonly ExecutionContentBlock[]): void {
    this.assertOwner(generation);
    if (blocks.reduce((size, block) => size + Buffer.byteLength(JSON.stringify(block)), 0) > EXECUTION_CONTENT_LIMITS.transferBytes) throw new ExecutionStoreError("execution_content_transfer_too_large");
    for (const block of blocks) this.contentCache.parse(block);
    this.data.transaction(() => {
      this.assertOwner(generation);
      const insert = this.statement("INSERT OR IGNORE INTO execution_content VALUES(?,?)");
      const read = this.statement("SELECT value FROM execution_content WHERE id=?");
      for (const block of blocks) {
        const checked = this.readContext?.blocks.get(block.id);
        if (checked) {
          if (checked.text !== block.text) throw new ExecutionStoreError("execution_content_corrupt");
          this.contentStatistics.add("content.readReuses");
          continue;
        }
        const previous = read.get(block.id) as {value: string} | undefined;
        if (previous && previous.value !== block.text) throw new ExecutionStoreError("execution_content_corrupt");
        insert.run(block.id, block.text);
        this.readContext?.blocks.set(block.id, Object.freeze({...block}));
      }
    })();
  }

  readContentBlock(id: string): ExecutionContentBlock {
    this.assertOwner(this.generation);
    const retained = this.readContext?.blocks.get(id);
    if (retained) {this.contentStatistics.add("content.readReuses"); return retained;}
    this.contentStatistics.add("content.reads");
    const row = this.statement("SELECT value FROM execution_content WHERE id=?").get(id) as {value: string} | undefined;
    if (!row) throw new ExecutionStoreError("execution_content_missing");
    const block = Object.freeze({id, text: row.value});
    this.contentStatistics.add("content.readBytes", Buffer.byteLength(block.text));
    this.contentCache.parse(block);
    this.readContext?.blocks.set(id, block);
    return block;
  }

  retainContent(value: unknown): ExecutionContentRoot {
    const original=value!==null&&typeof value==="object"?this.contentScope?.verifiedRoots.get(value):undefined;
    if(original) {this.contentStatistics.add("content.returnRootReuses");return original;}
    const packed = this.timed("content.encode", () => this.contentEncoder.pack(value, this.contentScope));
    let batch: ExecutionContentBlock[] = [], bytes = 0;
    for (const block of packed.blocks) {
      const size = Buffer.byteLength(JSON.stringify(block));
      if (bytes + size > EXECUTION_CONTENT_LIMITS.transferBytes) { this.stageContent(this.generation, batch); batch = []; bytes = 0; }
      batch.push(block); bytes += size;
    }
    if (batch.length) this.stageContent(this.generation, batch);
    return {format: 1, root: packed.root};
  }

  hydrateContent(root: ExecutionContentRoot): unknown {
    // Activity reads also need a consistent closure and transaction-local owner proof.
    if (!this.readContext) return this.checkpointTransaction(() => this.hydrateContent(root));
    const key=JSON.stringify(root);
    this.contentStatistics.add("content.rootReads");
    if(this.readContext.checkpoints.has(key)) {this.contentStatistics.add("content.rootReuses");return this.readContext.checkpoints.get(key);}
    const value=this.timed("content.expand", () => unpackExecutionContent(root, id => this.readContentBlock(id), this.contentCache, true, this.contentScope));
    this.readContext.checkpoints.set(key,value);
    return value;
  }

  verifiedContentRoot(value:unknown,minimumBytes=0):ExecutionContentRoot|null {
    if(value===null||typeof value!=="object"||(this.contentScope?.verifiedRootBytes.get(value)??0)<minimumBytes)return null;
    const root=value!==null&&typeof value==="object"?this.contentScope?.verifiedRoots.get(value):undefined;
    if(root)this.contentStatistics.add("content.returnRootReuses");
    return root??null;
  }

  encodeResponseContent(value:unknown) {
    this.assertOwner(this.generation);
    return this.timed("content.encode_response",()=>this.contentEncoder.pack(value,this.contentScope));
  }

  confirmTransferOwner(generation:number):void {this.assertOwner(generation);}

  /** Synchronous command lifetime, independent of SQLite transaction/ACK scope. */
  withContentScope<T>(body: () => T): T {
    if (this.contentScope) return body();
    this.contentScope = new ExecutionContentScope();
    try {return body();} finally {this.contentScope = undefined;}
  }

  takeContentStatistics(): Readonly<Record<string, number>> {return this.contentStatistics.take();}

  private encodeCheckpoint<T>(value: T): {text: string; digest: string; value: T} {
    const root = this.retainContent(value);
    // Validation and staging are synchronous; do not rehydrate the entire input
    // merely to validate owner relationships in the same transaction.
    return {text: JSON.stringify(root), digest: root.root, value: snapshotEncodedExecutionContent(value)};
  }

  private readCheckpoint(row: {value: string; digest: string}): unknown {
    try {
      const root = JSON.parse(row.value) as ExecutionContentRoot;
      if (root.root !== row.digest) throw new ExecutionStoreError("execution_records_corrupt");
      // The exact envelope, not a mutable latest-head selector, identifies a read.
      if (this.readContext?.checkpoints.has(row.value)) return this.readContext.checkpoints.get(row.value);
      const value = this.hydrateContent(root);
      this.readContext?.checkpoints.set(row.value, value);
      return value;
    } catch (cause) { throw new ExecutionStoreError("execution_records_corrupt", {cause}); }
  }

  private statement(sql: string): Database.Statement {
    let value = this.statements.get(sql);
    if (!value) {value = this.data.prepare(sql); this.statements.set(sql, value);}
    return value;
  }

  private checkpointTransaction<T>(body: () => T): T {
    if (this.readContext) return body();
    if (!this.contentScope) return this.withContentScope(() => this.checkpointTransaction(body));
    const started = this.performanceDiagnostics ? performance.now() : 0;
    let bodyMs = 0;
    try {return this.data.transaction(() => {
      const bodyStarted = this.performanceDiagnostics ? performance.now() : 0;
      try {
        this.readContext = {ownerConfirmed: false, blocks: new Map(), checkpoints: new Map(), owners: new Map(), trees: new Map()};
        try {return body();} finally {this.readContext = null;}
      } finally {
        if (this.performanceDiagnostics) {
          bodyMs = performance.now() - bodyStarted;
          this.recordTiming("checkpoint.body", bodyMs);
        }
      }
    })();} finally {
      if (this.performanceDiagnostics) {
        const totalMs = performance.now() - started;
        this.recordTiming("checkpoint.transaction", totalMs);
        this.recordTiming("checkpoint.boundary", Math.max(0, totalMs - bodyMs));
      }
    }
  }

  takePerformance(): readonly {stage: string; count: number; totalMs: number; maxMs: number}[] {
    const result = [...this.timings].map(([stage, value]) => ({stage, ...value}));
    this.timings.clear();
    return result;
  }

  private timed<T>(stage: string, work: () => T): T {
    if (!this.performanceDiagnostics) return work();
    const started = performance.now();
    try {return work();} finally {
      this.recordTiming(stage, performance.now() - started);
    }
  }

  private recordTiming(stage: string, ms: number): void {
    const value = this.timings.get(stage) ?? {count: 0, totalMs: 0, maxMs: 0};
    value.count++; value.totalMs += ms; value.maxMs = Math.max(value.maxMs, ms);
    this.timings.set(stage, value);
  }

  private validateSchema(format=FORMAT): void {
    // The complete versioned manifest checks names, types and definitions;
    // a second hand-maintained table/index list can contradict the schema.
    const row = this.data.prepare("SELECT version FROM store WHERE id=1").get() as { version: number } | undefined;
    const manifest=this.data.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (row?.version !== format || !isDeepStrictEqual(manifest,supportedSchema(format)) || this.data.pragma("quick_check", { simple: true }) !== "ok") {
      throw new ExecutionStoreError("execution_store_format_invalid");
    }
  }
}

function treeReceipt(commit: RunTreeCommit): RunTreeCommitReceipt {
  return {recordId: commit.id, revision: commit.revision,
    runs: commit.runs.map(run => ({recordId: run.id, revision: run.state.revision}))};
}

export function actionRecordIdentity(record: ActionOwnerRecord): { recordId: string; runId: string; actionId: string } {
  let runId: string, actionId: string, identity: string;
  switch (record.kind) {
    case "prepared_action": runId = record.value.runId; actionId = record.value.prepared.subject.ref.action.id; identity = actionId; break;
    case "preparation": runId = record.value.runId; actionId = record.value.prepared.subject.ref.action.id; identity = record.value.dispatchPlanFingerprint; break;
    case "dispatch_intent": runId = record.value.request.attempt.runId; actionId = record.value.request.attempt.action.id; identity = record.value.request.attempt.id; break;
    case "attempt_result": runId = record.value.result.attempt.runId; actionId = record.value.result.attempt.action.id; identity = record.value.result.attempt.id; break;
    case "retry": runId = record.value.runId; actionId = record.value.action.id; identity = record.value.attempt.id; break;
    case "settlement": runId = record.value.runId; actionId = record.value.settlement.action.id; identity = actionId; break;
  }
  token(runId); token(actionId); token(identity);
  return { recordId: recordKey(record.kind, runId, actionId, identity), runId, actionId };
}
function recordKey(kind: string, runId: string, actionId: string, identity: string): string {
  return `action-record:${createHash("sha256").update(JSON.stringify([kind, runId, actionId, identity])).digest("hex")}`;
}
function receipt(row: StoredActionRow): ExecutionRecordReceipt {
  return { recordId: row.record_id, generation: row.generation, sequence: row.sequence, digest: row.digest };
}
function encode(value: unknown): { text: string; digest: string } {
  const hash = digest(value);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > EXECUTION_STORE_LIMITS.recordBytes) throw new ExecutionStoreError("execution_record_too_large");
  return { text, digest: hash };
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalEncode("helarc.execution-record.v1", value)).digest("hex"); }
function equal(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function invalidReference(): never { throw new ExecutionStoreError("execution_record_reference_invalid"); }
function token(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) invalidReference();
}
function isBusy(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY"; }
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
