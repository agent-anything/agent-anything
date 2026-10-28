export interface MaterialVersionRef {
  readonly materialId: string;
  readonly version: string;
}
export interface MaterialRange extends MaterialVersionRef {
  readonly start: number;
  readonly end: number;
  readonly coordinate: "bytes";
}
export interface MaterialOrigin {
  readonly runId: string;
  readonly owner: string;
  readonly recordId: string;
  readonly revision: string;
  readonly occurredAt: string;
}
export interface MaterialVersion {
  readonly ref: MaterialVersionRef;
  readonly origin: MaterialOrigin;
  readonly label: string;
  readonly format: "utf8" | "json" | "opaque" | "locator";
  readonly mediaType: string;
  readonly bytes: number;
  readonly digest: string;
  readonly capture: "complete" | "prefix" | "incomplete";
  readonly limitations: readonly string[];
}
/** The host supplies this identity. A Tool argument or a cursor is not authority. */
export interface MaterialRecipient {
  readonly runId: string;
  readonly recipient: string;
  readonly purpose: string;
}
export interface MaterialCustodyIntent {
  readonly id: string;
  readonly instanceId: string;
  readonly activityId: string;
  /** Size and digest may be unknown while capture is in progress. Completion fixes both. */
  readonly version: Omit<MaterialVersion,"bytes"|"digest"> & {readonly bytes:number|null;readonly digest:string|null};
  readonly maximumBytes: number;
  readonly owner: string;
}
export interface MaterialCustodyState {
  readonly intent: MaterialCustodyIntent;
  readonly state: "staging" | "complete" | "published" | "sealed" | "deleted";
  readonly bytes: number;
  readonly chunks: number;
  readonly cleanupId: string | null;
  readonly version:MaterialVersion|null;
}
export interface MaterialHold {
  readonly id: string;
  readonly instanceId: string;
  readonly consumer: MaterialRecipient;
  readonly responsibility: "preparation" | "checkpoint" | "selection" | "input" | "delivery" | "detail" | "access" | "audit" | "cache";
  readonly range: MaterialRange;
  readonly basis: string;
  readonly releaseCondition: string;
}
export interface MaterialGrant {
  readonly id: string;
  readonly instanceId: string;
  readonly recipient: MaterialRecipient;
  readonly range: MaterialRange;
  readonly revision: number;
  readonly allowed: boolean;
  readonly basis: string;
}
export interface MaterialAccess {
  readonly id: string;
  readonly holdId: string;
  readonly recipient: MaterialRecipient;
  readonly range: MaterialRange;
}
export interface MaterialReadPage {
  readonly version: MaterialVersion;
  readonly instanceId: string;
  readonly start: number;
  readonly end: number;
  readonly bytesBase64: string;
  readonly text: string | null;
  readonly next: number | null;
}
export interface MaterialSearchRequest extends MaterialAccess {
  readonly query: string;
  readonly caseMode: "sensitive" | "ascii_insensitive";
  readonly maximumMatches: number;
  readonly scanBytes: number;
  readonly cursor?: string;
}
export interface MaterialSearchPage {
  readonly version: MaterialVersionRef;
  readonly matches: readonly {readonly start:number;readonly end:number;readonly text:string}[];
  readonly scanned: {readonly start:number;readonly end:number};
  readonly complete: boolean;
  readonly next: string | null;
  readonly stop: "range_end" | "match_limit" | "scan_budget";
}
export interface MaterialAccessDescription {readonly hold:MaterialHold;readonly version:MaterialVersion;}
export interface MaterialDiscoveryPage {
  readonly values:readonly {readonly sequence:number;readonly instanceId:string;readonly version:MaterialVersion;readonly hold:MaterialHold}[];
  readonly frontier:number;
  readonly next:number|null;
}
export interface MaterialDiscoveryFilter {
  readonly sourceRunId?:string;
  readonly sourceOwner?:string;
  readonly sourceRecordId?:string;
  readonly activityId?:string;
  readonly materialId?:string;
  readonly format?:MaterialVersion["format"];
  readonly occurredFrom?:string;
  readonly occurredBefore?:string;
  readonly labelIncludes?:string;
}
export interface MaterialStructuredRead {
  readonly version:MaterialVersion;
  readonly instanceId:string;
  readonly path:readonly string[];
  readonly value:unknown;
  readonly sourceRange:MaterialRange;
  readonly coordinate:"json_path";
  readonly complete:true;
}
export type MaterialCustodyCommand =
  | {readonly kind:"begin";readonly intent:MaterialCustodyIntent}
  | {readonly kind:"append";readonly id:string;readonly intentId:string;readonly offset:number;readonly bytesBase64:string}
  | {readonly kind:"complete";readonly intentId:string}
  | {readonly kind:"state";readonly intentId:string}
  | {readonly kind:"abandon";readonly intentId:string;readonly owner:string;readonly basis:string;readonly cleanupId:string}
  | {readonly kind:"describe";readonly holdId:string;readonly recipient:MaterialRecipient}
  | {readonly kind:"hold";readonly hold:MaterialHold}
  | {readonly kind:"release";readonly holdId:string;readonly basis:string}
  | {readonly kind:"grant";readonly grant:MaterialGrant;readonly expectedRevision:number|null}
  | {readonly kind:"read";readonly access:MaterialAccess;readonly offset:number;readonly length:number}
  | {readonly kind:"read_structure";readonly access:MaterialAccess;readonly path:readonly string[];readonly maximumSourceBytes:number;readonly maximumResultBytes:number}
  | {readonly kind:"search";readonly request:MaterialSearchRequest}
  | {readonly kind:"discover";readonly recipient:MaterialRecipient;readonly after:number;readonly frontier:number|null;readonly limit:number;readonly filter?:MaterialDiscoveryFilter}
  | {readonly kind:"seal";readonly instanceId:string;readonly cleanupId:string}
  | {readonly kind:"delete";readonly instanceId:string;readonly cleanupId:string;readonly maximumChunks:number};
export type MaterialCustodyValue = MaterialCustodyState | MaterialReadPage | MaterialSearchPage | MaterialStructuredRead | MaterialAccessDescription | MaterialDiscoveryPage | null;
export interface MaterialCustodyPort {command(command:MaterialCustodyCommand):Promise<MaterialCustodyValue>;}
export class MaterialCustodyError extends Error {
  constructor(readonly code:string) {super(code);this.name="MaterialCustodyError";}
}
export function custodyToken(value:unknown): asserts value is string {
  if (typeof value!=="string" || !value.trim() || value.length>2048) throw new MaterialCustodyError("material_identity_invalid");
}
export function custodyCount(value:number, maximum=Number.MAX_SAFE_INTEGER):void {
  if (!Number.isSafeInteger(value) || value<0 || value>maximum) throw new MaterialCustodyError("material_bound_invalid");
}
export function sameMaterialVersion(a:MaterialVersionRef,b:MaterialVersionRef):boolean {
  return a.materialId===b.materialId && a.version===b.version;
}
export function containsMaterialRange(outer:MaterialRange,inner:MaterialRange):boolean {
  return sameMaterialVersion(outer,inner) && outer.coordinate==="bytes" && inner.coordinate==="bytes" && outer.start<=inner.start && outer.end>=inner.end;
}
