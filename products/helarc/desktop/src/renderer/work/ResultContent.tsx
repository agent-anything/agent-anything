import * as React from "react";
import { useState } from "react";
import { FileText } from "lucide-react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";
import type { ArtifactContentRead } from "../../shared/HelarcWorkbench.js";
import {
  CopyButton,
  MarkdownContent,
} from "../conversation/MarkdownContent.js";
import { useRead } from "../workbench/useRead.js";

export function ResultLinks({
  snapshot,
  artifactIds,
}: {
  snapshot: HelarcMainSnapshot;
  artifactIds: readonly string[];
}) {
  return (
    <div className="wb-results">
      {artifactIds.map((id) => {
        const artifact = snapshot.activeThread?.artifacts.find(
          (a) => a.id === id,
        );
        if (
          !artifact ||
          !snapshot.activeThread ||
          artifact.kind === "final-output"
        )
          return null;
        return (
          <details key={id}>
            <summary>
              <FileText size={14} />
              {artifact.title}
            </summary>
            {artifact.summary && <p>{artifact.summary}</p>}
            <ResultContent
              threadId={snapshot.activeThread.id}
              artifactId={id}
            />
          </details>
        );
      })}
    </div>
  );
}
function ResultContent({
  threadId,
  artifactId,
}: {
  threadId: string;
  artifactId: string;
}) {
  const [cursor, setCursor] = useState<string | null>(null),
    [opened, setOpened] = useState(false),
    [json, setJson] = useState(false);
  const read = useRead<ArtifactContentRead>(
    JSON.stringify([threadId, artifactId, cursor]),
    0,
    () => window.helarc.readArtifactContent({ threadId, artifactId, cursor }),
    opened,
  );
  const page = read.value;
  let text = page?.status === "page" ? page.text : "";
  if (json) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* Text content is not necessarily JSON. */
    }
  }
  return (
    <>
      {!opened ? (
        <button className="wb-link" onClick={() => setOpened(true)}>
          View result
        </button>
      ) : (
        <>
          {page?.status === "page" && (
            <>
              <div className="wb-inline-actions">
                <CopyButton text={text} />
                <button className="wb-link" onClick={() => setJson((v) => !v)}>
                  {json ? "Plain text" : "Format JSON"}
                </button>
              </div>
              {page.mediaType.includes("markdown") && !json ? (
                <MarkdownContent text={text} />
              ) : (
                <pre>{text}</pre>
              )}
              {page.projected && (
                <p className="wb-muted">Bounded structured content</p>
              )}
              <p className="wb-muted">Completeness: {page.completeness}</p>
              <details className="wb-secondary">
                <summary>Integrity</summary>
                <pre>{JSON.stringify(page.integrity, null, 2)}</pre>
              </details>
              {page.limitations.map((s, i) => (
                <p className="wb-muted" key={i}>
                  {s}
                </p>
              ))}
              {page.nextCursor && (
                <button
                  className="wb-link"
                  onClick={() => setCursor(page.nextCursor)}
                >
                  Next content page
                </button>
              )}
              {cursor && (
                <button className="wb-link" onClick={() => setCursor(null)}>
                  Back to beginning
                </button>
              )}
            </>
          )}
          {page?.status === "unavailable" && (
            <p className="wb-muted">
              {page.reason === "restricted"
                ? "This content is restricted."
                : "Referenced content is not available here."}
            </p>
          )}
          {(page?.status === "rejected" || read.error) && (
            <button className="wb-link" onClick={read.refresh}>
              Result unavailable. Reload
            </button>
          )}
        </>
      )}
    </>
  );
}
