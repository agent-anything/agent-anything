import {createHash} from "node:crypto";
import type {RunSettlementCauseRef} from "../run/index.js";
import {strictRecord,token,nonNegativeInteger} from "./DelegationContract.js";

/** A locator for attributed output, not a grant or proof of semantic correctness. */
export interface DelegationNarrativeSource {
  readonly recordId:string;
  readonly runId:string;
  readonly cause:RunSettlementCauseRef;
  readonly digest:string;
  readonly bytes:number;
  readonly codeUnits:number;
}
export interface RetainedDelegationNarrative {readonly source:DelegationNarrativeSource;readonly text:string;}

export function createDelegationNarrativeSource(recordId:string,runId:string,cause:RunSettlementCauseRef,text:string):DelegationNarrativeSource {
  if(typeof text!=="string"||Buffer.from(text,"utf8").toString("utf8")!==text)throw new TypeError("delegation_narrative_encoding_invalid");
  return snapshotDelegationNarrativeSource({recordId,runId,cause,digest:`sha256:${createHash("sha256").update(text,"utf8").digest("hex")}`,
    bytes:Buffer.byteLength(text,"utf8"),codeUnits:text.length});
}

export function snapshotDelegationNarrativeSource(source:DelegationNarrativeSource):DelegationNarrativeSource {
  strictRecord(source,"DelegationNarrativeSource",["recordId","runId","cause","digest","bytes","codeUnits"]);
  strictRecord(source.cause,"DelegationNarrativeSource.cause",["run","id","revision"]);
  strictRecord(source.cause.run,"DelegationNarrativeSource.cause.run",["id"]);
  if(source.cause.run.id!==source.runId)throw new TypeError("delegation_narrative_source_mismatch");
  if(typeof source.digest!=="string"||!/^sha256:[a-f0-9]{64}$/.test(source.digest))throw new TypeError("delegation_narrative_digest_invalid");
  return Object.freeze({recordId:token(source.recordId,"source.recordId"),runId:token(source.runId,"source.runId"),cause:Object.freeze({run:Object.freeze({id:source.runId}),id:token(source.cause.id,"source.cause.id"),
    revision:token(source.cause.revision,"source.cause.revision")}),digest:source.digest,
    bytes:nonNegativeInteger(source.bytes,"source.bytes"),codeUnits:nonNegativeInteger(source.codeUnits,"source.codeUnits")});
}

export function verifyDelegationNarrativeSource(source:DelegationNarrativeSource,runId:string,cause:RunSettlementCauseRef,text:string):void {
  const original=snapshotDelegationNarrativeSource(source),actual=createDelegationNarrativeSource(source.recordId,runId,cause,text);
  if(original.runId!==actual.runId||original.cause.id!==actual.cause.id||original.cause.revision!==actual.cause.revision||
    original.digest!==actual.digest||original.bytes!==actual.bytes||original.codeUnits!==actual.codeUnits)
    throw new TypeError("delegation_narrative_source_mismatch");
}

export function snapshotRetainedDelegationNarrative(record:RetainedDelegationNarrative,expected:DelegationNarrativeSource):RetainedDelegationNarrative {
  strictRecord(record,"RetainedDelegationNarrative",["source","text"]);
  const source=snapshotDelegationNarrativeSource(record.source);
  if(source.recordId!==expected.recordId||source.digest!==expected.digest||source.bytes!==expected.bytes||source.codeUnits!==expected.codeUnits||
    source.runId!==expected.runId||source.cause.id!==expected.cause.id||source.cause.revision!==expected.cause.revision)
    throw new TypeError("delegation_narrative_source_mismatch");
  verifyDelegationNarrativeSource(source,expected.runId,expected.cause,record.text);
  return Object.freeze({source,text:record.text});
}
