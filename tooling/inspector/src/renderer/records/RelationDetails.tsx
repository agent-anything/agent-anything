import { lazy, Suspense } from "react";
import { Button, Collapse, Descriptions, Spin, Tag } from "antd";
import { FileTextOutlined, RightOutlined } from "@ant-design/icons";
import type { InspectionLink, InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { ContentTarget } from "../content/ContentLocation.js";

const ContentViewer = lazy(async () => ({ default: (await import("../content/ContentViewer.js")).ContentViewer }));

export function SubjectIdentity({ subject }: { subject: InspectionSubjectRef }) {
  return <span className="relation-identity"><strong>{subject.id}</strong>
    <small>{subject.owner} / {subject.kind}</small>
    <small>Run: {subject.runId ?? "Not Run-scoped"}</small>
    <small>Revision: {subject.revision ?? "Not revisioned"}</small>
  </span>;
}

export function RelationDetails({ link, onSubject, onRecord, onContent }: {
  link: InspectionLink; onSubject: (subject: InspectionSubjectRef) => void;
  onRecord: (id: string) => void; onContent: (target: ContentTarget) => void;
}) {
  return <div className="relation-details"><Tag>{link.kind}</Tag>
    {(["from", "to"] as const).map(endpoint => {
      const location = endpoint === "from" ? link.sourceLocation : link.targetLocation;
      return <section className="relation-endpoint" key={endpoint}>
        <h3>{endpoint === "from" ? "Source" : "Target"}</h3>
        <SubjectIdentity subject={link[endpoint]} />
        <Button type="link" icon={<RightOutlined aria-hidden="true" />} onClick={() => onSubject(link[endpoint])}>Open object</Button>
        {location ? <div className="data-transfer-location"><strong>{location.stage}</strong>
          {location.partId !== null && <span>Part: {location.partId}</span>}
          {location.jsonPointer !== null && <code>{location.jsonPointer || "/ (document root)"}</code>}
          {location.contentId ? <Button type="link" icon={<FileTextOutlined aria-hidden="true" />} onClick={() => onContent({
            id: location.contentId!, jsonPointer: location.jsonPointer ?? undefined,
            stage: location.stage, recordId: link.establishedBy,
          })}>Open recorded content</Button> : <span>Content reference not recorded</span>}
        </div> : <span className="data-unavailable">Content location not recorded</span>}
      </section>;
    })}
    <Descriptions column={1} size="small" items={[
      { key: "condition", label: "Condition", children: link.condition ?? "Not applicable" },
      { key: "operation", label: "Operation", children: link.operation ?? "Not recorded" },
      { key: "record", label: "Established by", children: <Button className="fact-link" type="link" icon={<FileTextOutlined aria-hidden="true" />} onClick={() => onRecord(link.establishedBy)}>{link.establishedBy}</Button> },
    ]} />
    <Collapse items={[{ key: "raw", label: "Raw relation", children: <Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(link, null, 2)} language="json" /></Suspense> }]} />
  </div>;
}
