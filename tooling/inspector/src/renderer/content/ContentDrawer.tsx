import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Empty, Spin, Tag, Tooltip } from "antd";
import { CopyOutlined, DownloadOutlined, SwapOutlined } from "@ant-design/icons";
import type { InspectionReadResult, InspectionSelection } from "@agent-anything/inspection/query";
import { inspectionQuery } from "../query-client/InspectorClient.js";
const ContentViewer = lazy(async () => ({ default: (await import("./ContentViewer.js")).ContentViewer }));
type Content = NonNullable<InspectionReadResult["content"]>;

export function ContentDrawer({ id, scope, onClose }: { id: string | null; scope: InspectionSelection | null; onClose: () => void }) {
  const [content, setContent] = useState<Content | null>(null);
  const [baseline, setBaseline] = useState<{ id: string; scope: InspectionSelection; name: string } | null>(null);
  const [compare, setCompare] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const active = ++generation.current; const abort = new AbortController();
    setContent(null); setCompare(undefined); setError(null); setBusy(false); setLoaded(false);
    if (id && scope) void (async () => {
      try {
        const result = await inspectionQuery({ ...scope, kind: "get_content", contentId: id }, abort.signal);
        if (active === generation.current) { setContent(result.content); setLoaded(true); }
        if (baseline && baseline.id !== id) {
          const previous = await inspectionQuery({ ...baseline.scope, kind: "get_content", contentId: baseline.id }, abort.signal);
          if (active === generation.current && previous.content?.descriptor.availability === "present") setCompare(previous.content.text);
        }
      } catch (failure) { if (!abort.signal.aborted) setError((failure as Error).message); }
    })();
    return () => { generation.current++; abort.abort(); };
  }, [id, scopeKey, baseline]);

  async function operate(operation: "more" | "copy" | "download") {
    if (!content || !scope || busy) return;
    const active = generation.current; setBusy(true); setError(null);
    try {
      const first = await inspectionQuery({ ...scope, kind: "get_content", contentId: content.descriptor.id, offset: operation === "more" ? content.nextOffset ?? 0 : 0 });
      if (active !== generation.current) return;
      if (first.content?.descriptor.availability !== "present") { setContent(first.content); setCompare(undefined); return; }
      if (operation === "more") {
        setContent({ ...first.content, offset: 0, text: content.text + first.content.text });
      } else if (operation === "copy") {
        await navigator.clipboard.writeText(content.text);
      } else {
        let range = first.content; let text = range.text;
        while (range.nextOffset !== null) {
          const next = await inspectionQuery({ ...scope, kind: "get_content", contentId: content.descriptor.id, offset: range.nextOffset });
          if (active !== generation.current) return;
          if (next.content?.descriptor.availability !== "present") { setContent(next.content); return; }
          range = next.content; text += range.text;
        }
        const url = URL.createObjectURL(new Blob([text], { type: content.descriptor.mediaType }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "inspection-content." + (content.descriptor.mediaType === "application/json" ? "json" : "txt"); anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) { if (active === generation.current) setError((failure as Error).message); }
    finally { if (active === generation.current) setBusy(false); }
  }
  return <Drawer title={content?.descriptor.name ?? "Recorded content"} open={id !== null} onClose={onClose} size="large" destroyOnHidden>
    {error && <Alert type="error" title={error} />}
    {content ? <><div className="content-metadata"><Tag>{content.descriptor.availability}</Tag><Tag>{content.descriptor.class}</Tag><span>{content.descriptor.retainedBytes} bytes</span>
      {content.descriptor.redacted && <Tag color="warning">Redacted fields</Tag>}{content.descriptor.truncated && <Tag color="warning">Truncated</Tag>}
      <Tooltip title="Copy loaded range"><Button aria-label="Copy loaded range" icon={<CopyOutlined />} disabled={busy || content.descriptor.availability !== "present"} onClick={() => { void operate("copy"); }} /></Tooltip>
      <Tooltip title="Download retained content"><Button aria-label="Download retained content" icon={<DownloadOutlined />} disabled={busy || content.descriptor.availability !== "present"} onClick={() => { void operate("download"); }} /></Tooltip>
      <Tooltip title="Set content comparison baseline"><Button aria-label="Set content comparison baseline" icon={<SwapOutlined />} disabled={!scope || content.descriptor.availability !== "present"} onClick={() => { if (scope) setBaseline({ id: content.descriptor.id, scope, name: content.descriptor.name }); }} /></Tooltip>
    </div>{baseline && <div className="coverage-note">Baseline: {baseline.name} @ {baseline.scope.watermark}{compare !== undefined ? " / first recorded range" : ""}</div>}
    {content.descriptor.availability === "present" ? <><Suspense fallback={<Spin />}><ContentViewer text={content.text} compare={compare} language={content.descriptor.mediaType === "application/json" ? "json" : "plaintext"} /></Suspense>
      {content.nextOffset !== null && <div className="view-toolbar"><span>Loaded {content.nextOffset} / {content.descriptor.retainedBytes} bytes</span><Button loading={busy} onClick={() => { void operate("more"); }}>Load next recorded range</Button></div>}</>
      : <Empty description={content.descriptor.availability === "not_captured" ? "Content was not captured for this record" : content.descriptor.unavailableReason ?? "Recorded content unavailable"} />}</> : loaded || error ? <Empty description="Recorded content unavailable" /> : <Spin />}
  </Drawer>;
}
