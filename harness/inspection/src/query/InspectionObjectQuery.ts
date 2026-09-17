import { inspectionSubjectKey, type InspectionRecord, type InspectionSubjectRef } from "../records/index.js";
import type { InspectionDatabase } from "../storage/index.js";
import type { InspectionObjectSummary, InspectionTimelineInterval } from "./InspectionQuery.js";
import { captureClassEnabled, type InspectionCapturePolicy } from "../content/index.js";

export function resolveRunScope(db: InspectionDatabase, watermark: number, runId?: string, descendants = false): {runIds?: string[]; limitations: string[]} {
  if (!runId) return {limitations: []};
  if (!descendants) return {runIds: [runId], limitations: []};
  const runs = db.subjects(watermark, "run", 0, 501);
  const limitations = new Set<string>(runs.length > 500 ? ["run_scope_limited"] : []);
  const parents = new Map<string, string | null>();
  const invalid = new Set<string>();
  for (const record of runs.slice(0,500)) if (record.payload.kind === "snapshot") {
    if (parents.has(record.subject.id) && parents.get(record.subject.id) !== record.payload.parentRunId) {invalid.add(record.subject.id); limitations.add("run_parent_ambiguous");}
    parents.set(record.subject.id,record.payload.parentRunId);
  }
  for (const [id,parent] of parents) {
    const seen = new Set([id]); let cursor = parent;
    while(cursor) {
      if(seen.has(cursor)) {invalid.add(id);limitations.add("run_parent_cycle");break;}
      seen.add(cursor);
      if(!parents.has(cursor)) {limitations.add("run_parent_not_observed");break;}
      cursor=parents.get(cursor) ?? null;
    }
  }
  const accepted = new Set([runId]);
  for (let pass = 0; pass < runs.length; pass++) {
    const before = accepted.size;
    for (const [id,parent] of parents) if (!invalid.has(id) && parent && accepted.has(parent)) accepted.add(id);
    if (accepted.size === before) break;
  }
  return {runIds: [...accepted], limitations:[...limitations]};
}

export function objectLabel(record: InspectionRecord): string {
  const payload = record.payload;
  if (payload.kind === "definition") return payload.name;
  if (payload.kind === "snapshot") return payload.agentId ?? record.subject.kind;
  if (payload.kind === "request") return `${payload.purpose} / ${payload.model ?? payload.providerId}`;
  if (payload.kind === "flow_definition") return payload.definition.label;
  if (payload.kind === "flow_invocation") return payload.observation.definition.id;
  if (payload.kind === "flow_step") return payload.observation.stepId;
  if (payload.kind === "interval") return payload.activity;
  return record.subject.kind;
}

export function summarizeObjects(db: InspectionDatabase, records: readonly InspectionRecord[], watermark: number, policy?: InspectionCapturePolicy): InspectionObjectSummary[] {
  const facts = db.subjectFacts(records.map(record => inspectionSubjectKey(record.subject)), watermark);
  return records.map(record => {
    const key = inspectionSubjectKey(record.subject);
    const owned = facts.filter(fact => inspectionSubjectKey(fact.subject) === key);
    const historyLinks = db.relations(watermark, key, [], 0, 65);
    const bindings = record.subject.kind === "run" ? db.relations(watermark, key, ["binding"], 0, 65)
      : db.relations(watermark,key,["contains","materializes","produces","settles","cause"],0,65);
    const links = [...new Map([...bindings, ...historyLinks].map(link => [link.id,link])).values()];
    const targets = new Map<string, InspectionSubjectRef>();
    let expansionLimited=false;
    for (const link of links.slice(0, 64)) for (const ref of [link.from, link.to]) if (inspectionSubjectKey(ref) !== key) targets.set(inspectionSubjectKey(ref), ref);
    // Expand the recorded Call -> Run Action -> prepared Action -> Attempt chain,
    // not arbitrary graph neighbors or inferred execution stages.
    if(record.subject.kind === "call") {
      const visited=new Set<string>();
      for(let depth=0;depth<2;depth++) for(const [target,ref] of [...targets]) {
        if(ref.kind!=="action" || visited.has(target))continue;
        if(visited.size>=16){expansionLimited=true;continue;}
        visited.add(target);
        const candidates=db.relations(watermark,target,["materializes","contains"],0,17);
        if(candidates.length>16)expansionLimited=true;
        for(const link of candidates.slice(0,16)) {
          if(inspectionSubjectKey(link.from)!==target || !["action","attempt","operation"].includes(link.to.kind))continue;
          if(!links.some(candidate=>candidate.id===link.id))links.unshift(link);
          targets.set(inspectionSubjectKey(link.to),link.to);
        }
      }
    }
    const targetKeys=[...targets].sort(([,a],[,b])=>Number(!["provider-attempt","attempt","action"].includes(a.kind))-Number(!["provider-attempt","attempt","action"].includes(b.kind))).slice(0,64);
    const relatedRecords = targetKeys.flatMap(([target,ref]) => {
      if(["provider-attempt","attempt","action"].includes(ref.kind))return db.subjectFacts([target],watermark);
      const result = db.material(target, watermark) ?? db.latest(target, watermark); return result ? [result] : [];
    });
    const definition = relatedRecords.find(item => item.payload.kind === "definition");
    const request = owned.find(item => item.payload.kind === "request");
    let label = objectLabel(request ?? definition ?? record);
    const call = owned.find(fact=>fact.payload.kind === "event" && fact.payload.name === "model.call");
    const body = call?.contents.find(content=>content.stage === "decoded" && content.mediaType === "application/json");
    if (body?.availability === "present" && !body.truncated && body.retainedBytes <= 128*1024 && policy && captureClassEnabled(policy,body.class)) {
      try {const value=JSON.parse(db.readContent(body.id,watermark,0,128*1024)!.text); if(typeof value.name === "string" && value.modelCallRef?.id===record.subject.id) label=value.name.slice(0,256);} catch { /* A missing diagnostic body is not a fabricated label. */ }
    }
    const summary: InspectionObjectSummary = {subject: record.subject, record, label, facts: owned.length > 64 ? [...owned.slice(0, 32), ...owned.slice(-32)] : owned, links: links.slice(0, 64), relatedRecords, limited: expansionLimited || owned.length > 64 || links.length > 64 || targets.size > 64};
    // Bound each summary independently so one dense object cannot consume a page.
    let bytes=Buffer.byteLength(JSON.stringify({subject:record.subject,record,label}));
    const take = <T>(values:readonly T[], allowance=96*1024):T[] => {
      let used=0;
      return values.filter(value=>{const size=Buffer.byteLength(JSON.stringify(value));if(bytes+size>96*1024 || used+size>allowance)return false;bytes+=size;used+=size;return true;});
    };
    const priorityFacts = record.subject.kind === "run"
      ? [...summary.facts.filter(fact=>["snapshot","interval"].includes(fact.payload.kind)),...summary.facts.filter(fact=>!["snapshot","interval"].includes(fact.payload.kind))]
      : summary.facts;
    const retainedFacts=take(priorityFacts,32*1024).sort((a,b)=>a.commitSequence-b.commitSequence);
    const retainedLinks=take(summary.links,24*1024);
    const related=take(summary.relatedRecords);
    return {...summary,facts:retainedFacts,links:retainedLinks,relatedRecords:related,limited:summary.limited || retainedFacts.length<summary.facts.length || retainedLinks.length<summary.links.length || related.length<summary.relatedRecords.length};
  });
}

export function readIntervals(db: InspectionDatabase, records: readonly InspectionRecord[], watermark: number): {intervals: InspectionTimelineInterval[]; limitations: string[]} {
  const intervals: InspectionTimelineInterval[] = [];
  const limitations = new Set<string>();
  const horizons = new Map<string, string | null>();
  for (const start of records) {
    if (start.payload.kind !== "interval" || start.payload.phase !== "started") continue;
    if (!start.occurredAt) {limitations.add("interval_timestamp_not_recorded"); continue;}
    const following = db.intervalEnds(start, watermark);
    const first = following[0];
    const end = first?.payload.kind === "interval" && first.payload.phase === "settled" ? first : null;
    if (first && !end) limitations.add("interval_start_without_settlement");
    if (end && following[1]?.payload.kind === "interval" && following[1].payload.phase === "settled") {limitations.add("interval_settlement_ambiguous"); continue;}
    if (end && (!end.occurredAt || Date.parse(end.occurredAt) < Date.parse(start.occurredAt))) {limitations.add("source_clock_regression"); continue;}
    const clock = start.payload.clock;
    const process = start.payload.activity === "process" ? db.latest(inspectionSubjectKey(start.subject),watermark,"process"):null;
    const exit = process?.payload.kind === "process" ? process.payload.rootExit:null;
    if (!horizons.has(clock)) horizons.set(clock, db.clockHorizon(clock, watermark));
    intervals.push({id: start.id, subject: start.subject, activity: start.payload.activity, clock, start: start.occurredAt, end: end?.occurredAt ?? null,
      horizon: horizons.get(clock) ?? start.occurredAt, startRecordId: start.id, endRecordId: end?.id ?? null,
      status: end?.payload.kind === "interval" ? end.payload.status : null,
      markers:exit&&process ? [{label:`Root exit ${exit.code ?? exit.signal ?? "unknown"}`,occurredAt:exit.observedAt,recordId:process.id}]:[]});
  }
  return {intervals, limitations: [...limitations]};
}
