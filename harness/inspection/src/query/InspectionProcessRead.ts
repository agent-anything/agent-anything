import {createHash} from "node:crypto";
import {inspectionMeasurementObservationOrigin} from "../records/InspectionWorkMeasurement.js";
import {captureClassEnabled} from "../content/index.js";
import {inspectionEvidenceKey, inspectionSubjectKey, type InspectionRecord, type InspectionEvidenceBasis, type InspectionSubjectRef} from "../records/index.js";
import {inspectionProcessVariantDigest, type InspectionProcessReadFilter} from "../storage/InspectionProcessIndex.js";
import type {InspectionReadResult} from "./InspectionQuery.js";
import {InspectionManifestReader, type OpenRecording} from "./InspectionReadManifest.js";
import {processCursor, readProcessCursor, recordingKey, type ProcessCursor} from "./InspectionProcessValidation.js";
import type {InspectionContentAccess, InspectionProcessEntry, InspectionProcessQuery, InspectionProcessRead, InspectionProcessRelation, InspectionProcessScopeQuery, InspectionTargetRead, InspectionVariantRead, InspectionLocatedContent} from "./InspectionProcessQuery.js";

const CATEGORIES: Record<InspectionProcessQuery["kind"], readonly string[]> = {
  list_context_process: ["source","demand","decision","method","input","responsibility"],
  get_context_decision: ["demand","decision"], get_actual_input: ["selection","input"],
  get_context_path: ["method","coordination","responsibility"], get_source_reception: ["source","representation","delivery","material"],
  get_recovery_review: ["recovery"], get_process_observations: ["measurement","timing"],
};
function identity(record: InspectionRecord): InspectionEvidenceBasis | null {
  const p=record.payload;
  if(p.kind==="process_evidence") return {origin:p.origin,digest:p.digest};
  if(p.kind==="process_relationship")return p.evidence;
  if(p.kind==="work_measurement")return {origin:inspectionMeasurementObservationOrigin(p),digest:inspectionProcessVariantDigest(record)!};
  if(p.kind==="work_timing")return {origin:{owner:p.owner,id:JSON.stringify([p.intervalId,p.boundary]),runId:p.runId,revision:"1"},digest:createHash("sha256").update(JSON.stringify(p,(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest("hex")};
  return null;
}
function access(record: InspectionRecord, opened: OpenRecording): InspectionContentAccess[] {
  return record.contents.map(descriptor=>({descriptor,availability:descriptor.availability==="not_captured"?"not_captured":descriptor.availability==="unavailable"?"unavailable":opened.policy&&captureClassEnabled(opened.policy,descriptor.class)?"available":"denied"}));
}
function target(reader: InspectionManifestReader, subject: InspectionSubjectRef): InspectionTargetRead {
  const opened=reader.get(subject);
  if(!opened)return {subject,availability:"external",firstRecordId:null};
  if(!opened.db)return {subject,availability:opened.read.availability==="introduction_unavailable"?"unavailable":opened.read.availability as Exclude<InspectionTargetRead["availability"],"recorded"|"referenced_only"|"external">,firstRecordId:null};
  const boundary=reader.manifest.recordings.find(r=>recordingKey(r)===recordingKey(subject))!.projectionWatermark;
  if((opened.read.coverage?.processProjection?.cursor??0)<boundary)return {subject,availability:"unavailable",firstRecordId:null};
  try {const first=opened.db.process.facts({watermark:boundary,subjectKey:inspectionSubjectKey(subject),limit:1})[0];
    if(first)opened.db.verifiedRecord(first.id,boundary);
    return {subject,availability:first?"recorded":"referenced_only",firstRecordId:first?.id??null};
  } catch {return {subject,availability:"corrupt",firstRecordId:null};}
}
function locatedContent(reader:InspectionManifestReader,subject:InspectionSubjectRef,location:import("../records/index.js").InspectionContentLocation|null):InspectionLocatedContent|null {
  if(!location)return null;
  const opened=reader.get(subject),recording={sourceId:subject.sourceId,datasetId:subject.datasetId};
  const base={location,recording,recordId:null,access:null};
  if(!opened)return {...base,availability:"external"};
  if(!opened.db)return {...base,availability:"unavailable"};
  if(!location.contentId)return {...base,availability:"not_observed"};
  const id=opened.db.contentRecord(location.contentId,opened.read.selection.watermark);
  const record=id?opened.db.verifiedRecord(id,opened.read.selection.watermark):null;
  const content=record?access(record,opened).find(a=>a.descriptor.id===location.contentId):undefined;
  return {...base,recordId:id,access:content??null,availability:!content?"not_observed":content.availability==="denied"?"denied":"recorded"};
}

export function executeProcessQuery(root: string, query: InspectionProcessQuery | InspectionProcessScopeQuery, base: InspectionReadResult): InspectionReadResult {
  const cursor="section" in query?readProcessCursor(query):null;
  const reader=new InspectionManifestReader(root,query.kind==="open_process_scope"?query:query.manifest);
  try {
    const readings=reader.recordings.map(r=>r.read);
    const incomplete=readings.some(r=>r.availability!=="available"||r.index!=="complete");
    const process:InspectionProcessRead={version:"1",family:query.kind,manifest:reader.manifest,recordings:readings,entries:[],relationships:[],variants:[],page:{next:null,reason:"end"},scan:incomplete?"incomplete":"complete",...("subject" in query&&query.subject?{anchor:target(reader,query.subject)}:{})};
    if(query.kind==="open_process_scope")return {...base,process};
    if(query.kind==="get_process_content") {
      const opened=reader.get(query.location);
      if(!opened)throw new Error("inspection_access_denied");
      if(!opened.db)return {...base,process,limitations:[opened.read.limitation!]};
      const record=opened.db.verifiedRecord(query.location.recordId,opened.read.selection.watermark);
      const contentAccess=record?access(record,opened).find(a=>a.descriptor.id===query.location.contentId):undefined;
      if(!contentAccess)return {...base,process,limitations:["content_not_observed"]};
      if(contentAccess.availability==="denied")return {...base,process:{...process,contentAccess},limitations:["content_access_denied"]};
      const content=opened.db.readContent(query.location.contentId,opened.read.selection.watermark,query.offset??0,query.length??262144);
      return {...base,content,process:{...process,contentAccess:content?.descriptor.availability==="unavailable"?{descriptor:content.descriptor,availability:"unavailable"}:contentAccess}};
    }
    const entries:InspectionProcessEntry[]=[],relationships:InspectionProcessRelation[]=[],variants:InspectionVariantRead[]=[];
    let bytes=0,count=0,last:ProcessCursor=cursor!,next:string|null=null,reason:InspectionProcessRead["page"]["reason"]="end";
    const limit=query.limit??50;
    outer: for(let i=cursor!.recording;i<reader.recordings.length;i++) {
      const opened=reader.recordings[i]!;if(!opened.db)continue;
      const indexed=reader.manifest.recordings[i]!.projectionWatermark;
      if((opened.read.coverage?.processProjection?.cursor??0)<indexed)continue;
      const start=i===cursor!.recording?cursor!:{recording:i,sequence:0,key:""};
      const selection=opened.read.selection;
      if(query.subject&&recordingKey(query.subject)!==recordingKey(selection)&&query.section!=="relationships")continue;
      const filter:InspectionProcessReadFilter={watermark:indexed,after:start.sequence,afterKey:start.key,limit:limit-count+1,
        ...(query.subject?{subjectKey:inspectionSubjectKey(query.subject)}:{}),...(query.evidence?{evidenceKey:inspectionEvidenceKey(query.evidence.origin),basisDigest:query.evidence.digest}:{}),
        recordId:query.recordId,runId:query.runId,runIds:query.runIds,fromSequence:query.fromSequence,throughSequence:query.throughSequence,purpose:query.purpose,recipient:query.recipient,category:query.category,
        categories:query.categories??(!query.subject&&!query.evidence&&!query.category?CATEGORIES[query.kind]:undefined),recordingLinks:query.kind==="get_recovery_review"};
      const rows=query.section==="relationships"?opened.db.process.relationPage(filter):query.section==="variants"?
        opened.db.process.variants({...filter,evidenceKey:inspectionEvidenceKey(query.evidence!.origin)}):opened.db.process.facts(filter);
      for(const row of rows) {
        if(count>=limit){next=processCursor(query,last);reason="page_limit";break outer;}
        let item:InspectionProcessEntry|InspectionProcessRelation|InspectionVariantRead;
        let sequence:number,key="";
        if("link" in row){
          const {record,link}=row;const verified=opened.db.verifiedRecord(record.id,indexed);
          if(!verified||!verified.links.some(l=>JSON.stringify(l)===JSON.stringify(link)))throw new Error("inspection_dataset_corrupt");
          sequence=record.commitSequence;key=link.id;
          item={link,observation:{...selection,recordId:record.id,sequence},identity:identity(record),ordinal:record.payload.kind==="process_relationship"?record.payload.ordinal:null,total:record.payload.kind==="process_relationship"?record.payload.total:null,source:target(reader,link.from),target:target(reader,link.to),sourceContent:locatedContent(reader,link.from,link.sourceLocation),targetContent:locatedContent(reader,link.to,link.targetLocation)};
        } else if("firstSequence" in row){
          const record=opened.db.verifiedRecord(row.recordId,indexed),basis=record?identity(record):null;
          if(!record||record.commitSequence!==row.firstSequence||!basis||inspectionEvidenceKey(basis.origin)!==inspectionEvidenceKey(query.evidence!.origin)||inspectionProcessVariantDigest(record)!==row.digest)throw new Error("inspection_dataset_corrupt");
          sequence=row.firstSequence;item={...row,selection,identity:query.evidence!.origin};
        }
        else {opened.db.verifiedRecord(row.id,indexed);sequence=row.commitSequence;const p=row.payload;
          item={record:row,identity:identity(row),contents:access(row,opened),relationCoverage:p.kind==="process_evidence"?{declared:p.relationCount,...opened.db.process.relationCoverage({watermark:indexed,evidence:p})}:null};}
        const size=Buffer.byteLength(JSON.stringify(item));
        if(bytes+size>1024*1024){next=processCursor(query,last);reason="byte_limit";break outer;}
        bytes+=size;count++;last={recording:i,sequence,key};
        if(query.section==="relationships")relationships.push(item as InspectionProcessRelation);
        else if(query.section==="variants")variants.push(item as InspectionVariantRead);
        else entries.push(item as InspectionProcessEntry);
      }
    }
    return {...base,next,process:{...process,entries,relationships,variants,page:{next,reason},scan:next?"more":incomplete?"incomplete":"complete"}};
  } finally {reader.close();}
}
