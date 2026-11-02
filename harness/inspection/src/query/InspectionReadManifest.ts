import {existsSync, readFileSync, statSync} from "node:fs";
import {containedInspectionPath, datasetDirectory, INSPECTION_SOURCE_FORMAT_VERSION, type InspectionSource} from "../sources/index.js";
import {InspectionDatabase, wasInspectionDatasetRetired} from "../storage/index.js";
import {acquireInspectionReadLease} from "../storage/InspectionDatasetAccess.js";
import {validateInspectionCapturePolicy, type InspectionCapturePolicy} from "../content/index.js";
import type {InspectionReadManifest, InspectionRecordingRead, InspectionProcessScopeQuery} from "./InspectionProcessQuery.js";
import {recordingKey} from "./InspectionProcessValidation.js";

export interface OpenRecording {readonly read: InspectionRecordingRead; readonly db: InspectionDatabase | null; readonly policy: InspectionCapturePolicy | null; readonly close: () => void;}
function json(path: string): unknown {if (statSync(path).size > 64 * 1024) throw new Error("inspection_dataset_corrupt"); return JSON.parse(readFileSync(path, "utf8"));}
function limitation(error: unknown): InspectionRecordingRead["availability"] {
  const code = (error as NodeJS.ErrnoException)?.code, message = (error as Error)?.message;
  if (code === "EACCES" || code === "EPERM" || message === "inspection_access_denied") return "denied";
  if (code === "ENOENT" || message === "inspection_dataset_unavailable") return "unavailable";
  if (message === "inspection_dataset_cleared") return "retired";
  if (message === "inspection_dataset_unsupported" || message === "inspection_process_projection_unsupported") return "unsupported";
  return "corrupt";
}

/** Per-dataset immutable read boundaries, not a transaction across recordings. */
export class InspectionManifestReader {
  readonly recordings: OpenRecording[] = [];
  readonly manifest: InspectionReadManifest;
  constructor(root: string, input: InspectionReadManifest | Extract<InspectionProcessScopeQuery, {kind: "open_process_scope"}>) {
    const entries: InspectionReadManifest["recordings"][number][] = [];
    try {
      for (const requested of input.recordings) {
        let introductionUnavailable = false;
        if (requested.via) {
          const parent = this.recordings.find(r => recordingKey(r.read.selection) === recordingKey(requested.via!))!;
          if (!parent?.db) introductionUnavailable = true;
          else {
            let record;
            try {record = parent.db.verifiedRecord(requested.via.recordId, parent.read.selection.watermark);}
            catch {introductionUnavailable=true;}
            if (!record) introductionUnavailable = true;
            else {
              const target = requested.via.linkId === null
                ? record.payload.kind === "recording_link" ? record.payload.target : null
                : record.links.filter(l => l.id === requested.via!.linkId && l.establishedBy === record.id).flatMap(l=>[l.from,l.to]).find(ref=>recordingKey(ref)===recordingKey(requested));
              if (!target || recordingKey(target) !== recordingKey(requested)) throw new Error("inspection_access_denied");
            }
          }
        }
        let db: InspectionDatabase | null = null, policy: InspectionCapturePolicy | null = null;
        let release = () => {}, endRead = () => {};
        let watermark = requested.watermark;
        let availability: InspectionRecordingRead["availability"] = "available", reason: string | null = null;
        let coverage: InspectionRecordingRead["coverage"] = null;
        try {
          if (introductionUnavailable) {availability = "introduction_unavailable"; throw new Error("inspection_introduction_unavailable");}
          const source = json(containedInspectionPath(root, "sources", requested.sourceId, "source.json")) as InspectionSource;
          if (source.sourceId !== requested.sourceId || source.formatVersion !== INSPECTION_SOURCE_FORMAT_VERSION) throw new Error("inspection_dataset_unsupported");
          policy = validateInspectionCapturePolicy(json(containedInspectionPath(root, "sources", requested.sourceId, "read-policy.json")));
          const directory = datasetDirectory(root, requested.sourceId, requested.datasetId);
          if (!existsSync(directory)) throw new Error(wasInspectionDatasetRetired(root, requested.sourceId, requested.datasetId) ? "inspection_dataset_cleared" : "inspection_dataset_unavailable");
          release = acquireInspectionReadLease(directory); db = new InspectionDatabase(directory);
          endRead=db.beginReadSnapshot();
          if (db.manifest().sourceId !== requested.sourceId || db.manifest().datasetId !== requested.datasetId) throw new Error("inspection_dataset_corrupt");
          watermark ??= db.snapshot().watermark;
          coverage = db.snapshotAt(watermark);
        } catch (error) {
          endRead();endRead=()=>{};db?.close(); db = null; release(); release = () => {};
          if ((error as Error)?.message === "inspection_cursor_invalid") throw error;
          if (!introductionUnavailable) availability = limitation(error);
          reason = introductionUnavailable ? "inspection_introduction_unavailable" : `inspection_recording_${availability}`;
          if(watermark===undefined){
            const code=introductionUnavailable?"inspection_reference_unknown":availability==="denied"?"inspection_access_denied":availability==="unavailable"?"inspection_dataset_unavailable":availability==="retired"?"inspection_dataset_cleared":availability==="unsupported"?"inspection_dataset_unsupported":"inspection_dataset_corrupt";
            throw new Error(code);
          }
        }
        const selection = {sourceId: requested.sourceId, datasetId: requested.datasetId, watermark: watermark!};
        const projectionWatermark="projectionWatermark" in requested?requested.projectionWatermark as number:coverage?.processProjection?.cursor??0;
        entries.push({...selection, projectionWatermark, via: requested.via});
        const index = !coverage ? "unavailable" : coverage.processProjection?.version === "1" && coverage.processProjection.cursor>=projectionWatermark && projectionWatermark >= (coverage.recording?.native.target ?? watermark!) ? "complete" : "lagging";
        this.recordings.push({db, policy, read: {selection, availability, coverage, index, limitation: reason}, close: () => {endRead();db?.close(); release();}});
      }
      this.manifest = {version: "1", projectionVersion: "1", recordings: entries};
    } catch (error) {this.close(); throw error;}
  }
  get(location: {sourceId: string; datasetId: string}): OpenRecording | undefined {return this.recordings.find(r => recordingKey(r.read.selection) === recordingKey(location));}
  close(): void {for (const r of this.recordings.splice(0)) r.close();}
}
