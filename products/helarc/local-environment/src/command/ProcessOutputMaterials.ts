import {createHash} from "node:crypto";
import type {ProcessOutputCheckpoint} from "./ProcessOutputStore.js";
import type {ProcessSnapshot} from "./ProcessObservation.js";

export interface ProcessOutputMaterialView {
  readonly reference: {readonly id: string; readonly revision: string};
  readonly stream: "stdout" | "stderr";
  readonly segments: number;
  readonly bytes: number;
  readonly encoding: string | null;
  readonly integrity: string;
  readonly omittedBytes: number;
  readonly projectionPending: boolean;
  readonly capture: ProcessSnapshot["output"]["capture"];
  readonly capturePersistence: ProcessSnapshot["output"]["persistence"];
}

/** A reference describes an immutable decoded prefix, never a mutable storage path. */
export function describeProcessOutput(output: ProcessOutputCheckpoint, snapshot: ProcessSnapshot): readonly ProcessOutputMaterialView[] {
  return (["stdout", "stderr"] as const).map(stream => {
    const source = output.streams[stream], hash = createHash("sha256");
    let bytes = 0;
    for (const segment of source.segments) {hash.update(segment.text); bytes += Buffer.byteLength(segment.text);}
    const revision = `sha256:${hash.digest("hex")}`;
    const view = {stream, segments: source.segments.length, bytes, encoding: source.projection?.encoding ?? null,
      integrity: source.projection?.integrity ?? "unavailable", omittedBytes: source.omitted,
      projectionPending: source.projectionPending, capture: snapshot.output.capture,capturePersistence:snapshot.output.persistence};
    const id = `command-output:${createHash("sha256").update(JSON.stringify([snapshot.ref, revision, view])).digest("hex")}`;
    return {...view, reference: {id, revision}};
  });
}

export function processOutputViewSegments(output: ProcessOutputCheckpoint, view: ProcessOutputMaterialView, runId: string): readonly string[] {
  const source = output.streams[view.stream];
  if (!source || !Number.isSafeInteger(view.segments) || view.segments < 0 || view.segments > source.segments.length ||
      !Number.isSafeInteger(view.omittedBytes) || view.omittedBytes<0 || typeof view.projectionPending!=="boolean" ||
      !(view.encoding===null || typeof view.encoding==="string") || !["exact","inferred","lossy","unavailable"].includes(view.integrity) ||
      !["open","closed","incomplete"].includes(view.capture) || !["pending","complete","failed"].includes(view.capturePersistence)) throw new TypeError("Invalid output material prefix.");
  const basis={stream:view.stream,segments:view.segments,bytes:view.bytes,encoding:view.encoding,integrity:view.integrity,
    omittedBytes:view.omittedBytes,projectionPending:view.projectionPending,capture:view.capture,capturePersistence:view.capturePersistence};
  const id=`command-output:${createHash("sha256").update(JSON.stringify([{runId,executionId:output.executionId},view.reference.revision,basis])).digest("hex")}`;
  if (id!==view.reference.id) throw new TypeError("Output material identity mismatch.");
  const chunks = source.segments.slice(0, view.segments).map(segment => segment.text);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const chunk of chunks) {hash.update(chunk); bytes += Buffer.byteLength(chunk);}
  if (bytes !== view.bytes || `sha256:${hash.digest("hex")}` !== view.reference.revision) throw new TypeError("Output material integrity failed.");
  return chunks;
}
