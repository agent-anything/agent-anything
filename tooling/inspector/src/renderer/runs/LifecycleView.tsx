import { useMemo, useState } from "react";
import { Button, Table, Empty, Switch } from "antd";
import { ReactFlow, Background, Controls, MarkerType, type Node, type Edge } from "@xyflow/react";
import type { InspectionRecord } from "@agent-anything/inspection/records";

export function LifecycleView({ records, onRecord }: { records: readonly InspectionRecord[]; onRecord: (record: InspectionRecord) => void }) {
  const [showDefinition, setShowDefinition] = useState(false);
  const [route, setRoute] = useState<string | null>(null);
  const definition = [...records].reverse().find((record) => record.payload.kind === "lifecycle");
  const transitions = records.filter((record) => record.payload.kind === "transition");
  const states = [...new Set([...(definition?.payload.kind === "lifecycle" ? definition.payload.states : []), ...transitions.flatMap((record) => record.payload.kind === "transition" ? [record.payload.from, record.payload.to].filter((name): name is string => name !== null) : [])])];
  const rules = definition?.payload.kind === "lifecycle" ? definition.payload.transitions : [];
  const { nodes, edges } = useMemo(() => {
    const observed = new Map<string, InspectionRecord[]>();
    for (const record of transitions) if (record.payload.kind === "transition" && record.payload.from !== null) {
      const key = JSON.stringify([record.payload.from, record.payload.to]);
      const group = observed.get(key) ?? []; group.push(record); observed.set(key, group);
    }
    const nodes: Node[] = states.map((name, index) => ({ id: name, data: { label: name }, position: { x: (index % 3) * 240, y: Math.floor(index / 3) * 135 }, style: { width: 160, height: 44 } }));
    const edges: Edge[] = [...observed].map(([id, occurrences]) => {
      const [source, target] = JSON.parse(id) as [string, string];
      return { id, source, target, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, label: occurrences.map((item) => "#" + item.commitSequence).join(", "), style: { stroke: "#277463", strokeWidth: route === id ? 3.5 : 2 } };
    });
    if (showDefinition) for (const rule of rules) if (!observed.has(JSON.stringify([rule.from, rule.to]))) edges.push({ id: rule.id, source: rule.from, target: rule.to, type: "smoothstep", label: rule.trigger, style: { stroke: "#afb6bb", strokeDasharray: "5 5" } });
    return { nodes, edges };
  }, [records, showDefinition, route]);
  const visible = route ? transitions.filter((record) => record.payload.kind === "transition" && JSON.stringify([record.payload.from, record.payload.to]) === route) : transitions;
  return <div className="lifecycle-view"><div className="view-toolbar">
    <Switch size="small" aria-label="Show declared transitions" checked={showDefinition} onChange={setShowDefinition} /><span>Declared transitions</span><span>{transitions.length} recorded transitions</span>
    {route && <Button size="small" onClick={() => setRoute(null)}>All transitions</Button>}
  </div>{nodes.length ? <div className="lifecycle-map"><ReactFlow nodes={nodes} edges={edges} nodesConnectable={false} deleteKeyCode={null} fitView onEdgeClick={(_event, edge) => setRoute(edge.id)}>
    <Background /><Controls showInteractive={false} />
  </ReactFlow></div> : <Empty description="Lifecycle not recorded in this scope" />}
    <Table size="small" pagination={{ pageSize: 25, showSizeChanger: false }} rowKey="id" dataSource={visible} onRow={(record) => ({ onClick: () => onRecord(record) })} columns={[
      { title: "Commit", dataIndex: "commitSequence", width: 75 },
      { title: "Revision", render: (_value, record) => record.payload.kind === "transition" ? record.payload.revision : "" },
      { title: "From", render: (_value, record) => record.payload.kind === "transition" ? record.payload.from ?? "Not observed" : "" },
      { title: "To", render: (_value, record) => record.payload.kind === "transition" ? record.payload.to : "" },
      { title: "Trigger", render: (_value, record) => record.payload.kind === "transition" ? record.payload.reasonCode ?? record.payload.transitionId ?? "Not recorded" : "" },
    ]} />
  </div>;
}
