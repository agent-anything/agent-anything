import { Button, Tag, Tooltip } from "antd";
import { EyeOutlined } from "@ant-design/icons";
import type { InspectionLink } from "@agent-anything/inspection/records";

export function RecordRelations({ links, onRelation }: {
  links: readonly InspectionLink[];
  onRelation: (link: InspectionLink) => void;
}) {
  if (!links.length) return null;
  return <section className="record-relations" aria-label="Relations recorded here">
    <h3>Relations recorded here <span>{links.length}</span></h3>
    {links.map(link => <div className="record-relation" key={link.id}>
      <div className="record-relation-heading"><Tag>{link.kind}</Tag><Tooltip title="Inspect relation">
        <Button type="text" aria-label={`Inspect ${link.kind} relation`} icon={<EyeOutlined />} onClick={() => onRelation(link)} />
      </Tooltip></div>
      {link.condition !== null && <small>Condition: {link.condition}</small>}
      {link.operation !== null && <small>Operation: {link.operation}</small>}
    </div>)}
  </section>;
}
