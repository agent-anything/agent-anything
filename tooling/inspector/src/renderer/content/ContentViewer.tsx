import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";

(globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: (_id: string, label: string) => label === "json" ? new JsonWorker() : new EditorWorker() };
jsonDefaults.setDiagnosticsOptions({ validate: false, enableSchemaRequest: false });

export function ContentViewer({ text, compare, language = "plaintext" }: { text: string; compare?: string; language?: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const model = monaco.editor.createModel(text.slice(0, 2 * 1024 * 1024), language);
    const options = { readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12, wordWrap: "on" as const, contextmenu: false, links: false };
    if (compare !== undefined) {
      const original = monaco.editor.createModel(compare.slice(0, 2 * 1024 * 1024), language);
      const editor = monaco.editor.createDiffEditor(container.current, { ...options, renderSideBySide: true, originalEditable: false });
      editor.setModel({ original, modified: model });
      return () => { editor.dispose(); original.dispose(); model.dispose(); };
    }
    const editor = monaco.editor.create(container.current, { ...options, model });
    return () => { editor.dispose(); model.dispose(); };
  }, [text, compare, language]);
  return <div className="content-editor" ref={container} aria-label={compare === undefined ? "Recorded content" : "Content comparison"} />;
}
