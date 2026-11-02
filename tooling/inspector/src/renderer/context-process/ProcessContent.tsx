import {lazy, Suspense, useEffect, useRef, useState} from "react";
import {Alert, Button, Drawer, Spin, Tag, Tooltip} from "antd";
import {CopyOutlined, SwapOutlined} from "@ant-design/icons";
import type {InspectionReadManifest, InspectionReadResult} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";
const ContentViewer = lazy(async () => ({default: (await import("../content/ContentViewer.js")).ContentViewer}));
export interface ProcessContentTarget {
  sourceId: string; datasetId: string; recordId: string; contentId: string;
  jsonPointer?: string; stage?: string;
}
export function ProcessContent({manifest, target, onClose}: {manifest: InspectionReadManifest; target: ProcessContentTarget | null; onClose: () => void}) {
  const [result, setResult] = useState<InspectionReadResult | null>(null), [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0), [baseline, setBaseline] = useState<{manifest: InspectionReadManifest; target: ProcessContentTarget; offset: number} | null>(null);
  const [compare, setCompare] = useState<string | undefined>(), [compareNote, setCompareNote] = useState<string | null>(null);
  const copyRead=useRef<AbortController|null>(null);
  const key = JSON.stringify([manifest, target]), previous = useRef(key);
  const activeOffset = previous.current === key ? offset : 0;
  useEffect(() => {previous.current = key; setOffset(0);return()=>copyRead.current?.abort();}, [key]);
  useEffect(() => {
    const abort = new AbortController(); setResult(null); setError(null); setCompare(undefined); setCompareNote(null);
    const read = (m: InspectionReadManifest, t: ProcessContentTarget, at: number) => inspectionQuery({kind: "get_process_content", manifest: m,
      location: {sourceId: t.sourceId, datasetId: t.datasetId, recordId: t.recordId, contentId: t.contentId}, offset: at}, abort.signal);
    if (target) void (async () => {
      try {
        const next = await read(manifest, target, activeOffset);
        if (abort.signal.aborted) return;
        setResult(next);
        if (baseline && (baseline.target.contentId !== target.contentId || baseline.target.datasetId !== target.datasetId)) {
          const before = await read(baseline.manifest, baseline.target, baseline.offset);
          if (abort.signal.aborted) return;
          if (before.process?.contentAccess?.availability === "available" && before.content?.descriptor.availability === "present") setCompare(before.content.text);
          setCompareNote(`Baseline range @ ${baseline.offset}: ${before.process?.contentAccess?.availability ?? before.limitations.join(", ")}`);
        }
      } catch (e) {if (!abort.signal.aborted) setError((e as Error).message);}
    })();
    return () => abort.abort();
  }, [key, activeOffset, baseline]);
  const content = result?.content, access = result?.process?.contentAccess;
  async function copy() {
    if(!target)return;copyRead.current?.abort();const pending=new AbortController();copyRead.current=pending;
    try {
      const next=await inspectionQuery({kind:"get_process_content",manifest,location:{sourceId:target.sourceId,datasetId:target.datasetId,recordId:target.recordId,contentId:target.contentId},offset:activeOffset},pending.signal);
      if(pending.signal.aborted)return;
      if(next.process?.contentAccess?.availability!=="available"||next.content?.descriptor.availability!=="present"){setResult(next);setCompare(undefined);return;}
      await navigator.clipboard.writeText(next.content.text);
    } catch(e){if(!pending.signal.aborted)setError((e as Error).message);}
  }
  return <Drawer title={content?.descriptor.name ?? "Recorded content"} open={target !== null} onClose={onClose} size="large" destroyOnHidden>
    {target && <div className="coverage-note break-id">{target.stage ?? "Original recorded body"} / {target.recordId}{target.jsonPointer !== undefined && <> / JSON pointer: <code>{target.jsonPointer || "/ (root)"}</code></>}</div>}
    {error && <Alert type="error" title={error}/>}
    {result && <div className="view-toolbar"><Tag>{access?.availability ?? "unavailable"}</Tag><span>Range starts at {activeOffset} bytes</span>
      {content && <><Tag>{content.descriptor.class}</Tag>{content.descriptor.truncated && <Tag color="warning">Truncated capture</Tag>}{content.descriptor.redacted && <Tag color="warning">Redacted</Tag>}</>}
      <Tooltip title="Pin this recorded range for comparison"><Button aria-label="Pin process content baseline" icon={<SwapOutlined/>} disabled={!content || access?.availability !== "available"} onClick={() => target && setBaseline({manifest, target, offset: activeOffset})}/></Tooltip>
      <Tooltip title="Copy displayed range"><Button aria-label="Copy process content" icon={<CopyOutlined/>} disabled={!content || access?.availability !== "available"} onClick={() => void copy()}/></Tooltip>
    </div>}
    {compareNote && <div className="coverage-note">{compareNote}. Display comparison, not a recorded semantic assessment.</div>}
    {content?.descriptor.availability === "present" && access?.availability === "available" ? <>
      <Suspense fallback={<Spin/>}><ContentViewer text={content.text} compare={compare} jsonPointer={target?.jsonPointer} language={content.descriptor.mediaType === "application/json" ? "json" : "plaintext"}/></Suspense>
      <div className="view-toolbar">{activeOffset > 0 && <Button onClick={() => setOffset(0)}>First range</Button>}{content.nextOffset !== null && <Button onClick={() => setOffset(content.nextOffset!)}>Next recorded range</Button>}</div>
    </> : result ? <Alert type="warning" title={result.limitations.join(", ") || access?.availability || "Content unavailable"}/> : !error && target && <Spin/>}
  </Drawer>;
}
