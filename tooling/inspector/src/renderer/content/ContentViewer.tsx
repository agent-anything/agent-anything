import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Tooltip } from "antd";
import { CodeOutlined, UndoOutlined } from "@ant-design/icons";
import * as monaco from "monaco-editor/editor/editor.api";
// JSON support lazily loads editor features; register their services before creating models.
import "monaco-editor/features/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import { formatRecordedContent, formatRecordedJson } from "./formatRecordedContent.js";
import { locateJsonPointer } from "./ContentLocation.js";

(globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: (_id: string, label: string) => label === "json" ? new JsonWorker() : new EditorWorker() };
jsonDefaults.setDiagnosticsOptions({ validate: false, enableSchemaRequest: false });

type Presentation = { text: string; compare: string | undefined; language: string };

export function ContentViewer({ text, compare, language = "plaintext", jsonPointer }: { text: string; compare?: string; language?: string; jsonPointer?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const defaults = useMemo<Presentation>(() => ({
    text: formatRecordedContent(text, language),
    compare: compare === undefined ? undefined : formatRecordedContent(compare, language),
    language,
  }), [text, compare, language]);
  const [choice, setChoice] = useState<{ source: Presentation; value: Presentation; error: string | null } | null>(null);
  // A presentation choice belongs to this content, not the next opened record.
  const current = choice?.source === defaults ? choice : null;
  const displayed = current?.value ?? defaults;
  const location = useMemo(() => jsonPointer === undefined ? null : locateJsonPointer(displayed.text, jsonPointer), [displayed.text, jsonPointer]);

  function formatJson() {
    const formatted = formatRecordedJson(text);
    const baseline = compare === undefined ? undefined : formatRecordedJson(compare);
    const failure = formatted.kind === "unavailable" ? formatted : baseline?.kind === "unavailable" ? baseline : null;
    if (failure) {
      const subject = formatted.kind === "unavailable" ? "Loaded content" : "Comparison baseline";
      const error = failure.reason === "invalid_json" ? `${subject} is not valid JSON; it may be incomplete.` : `${subject} exceeds the JSON formatting display limit.`;
      setChoice({ source: defaults, value: displayed, error });
    } else if (formatted.kind === "formatted") {
      setChoice({ source: defaults, value: { text: formatted.text, compare: baseline?.kind === "formatted" ? baseline.text : undefined, language: "json" }, error: null });
    }
  }

  function showOriginal() {
    setChoice({ source: defaults, value: {
      text: formatRecordedContent(text, "plaintext"),
      compare: compare === undefined ? undefined : formatRecordedContent(compare, "plaintext"),
      language,
    }, error: null });
  }

  useEffect(() => {
    if (!container.current) return;
    const model = monaco.editor.createModel(displayed.text, displayed.language);
    const options = { readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12, wordWrap: "on" as const, contextmenu: false, links: false };
    if (displayed.compare !== undefined) {
      const original = monaco.editor.createModel(displayed.compare, displayed.language);
      const editor = monaco.editor.createDiffEditor(container.current, { ...options, renderSideBySide: true, originalEditable: false });
      editor.setModel({ original, modified: model });
      return () => { editor.dispose(); original.dispose(); model.dispose(); };
    }
    const editor = monaco.editor.create(container.current, { ...options, model });
    if (location) {
      const start = model.getPositionAt(location.offset); const end = model.getPositionAt(location.offset + location.length);
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      editor.setSelection(range); editor.revealRangeInCenter(range);
    }
    return () => { editor.dispose(); model.dispose(); };
  }, [displayed.text, displayed.compare, displayed.language, location]);
  return <div className="content-viewer">
    <div className="content-presentation-toolbar" role="toolbar" aria-label="Content presentation">
      <Tooltip title="Format JSON"><Button size="small" aria-label="Format JSON" icon={<CodeOutlined />} onClick={formatJson} /></Tooltip>
      <Tooltip title="Show original recorded text"><Button size="small" aria-label="Original" icon={<UndoOutlined />} onClick={showOriginal} /></Tooltip>
    </div>
    {current?.error && <Alert type="warning" showIcon title={current.error} />}
    {jsonPointer !== undefined && !location && <Alert type="warning" title="Recorded JSON location is not available in the loaded content." />}
    <div className="content-editor" ref={container} aria-label={compare === undefined ? "Recorded content" : "Content comparison"} />
  </div>;
}
