import { useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState, type Node, type NodeProps, type Edge, type ReactFlowInstance } from "@xyflow/react";
import type { InspectionLink, InspectionSubjectRef } from "@agent-anything/inspection/records";
import { Button, Tooltip } from "antd";
import { AimOutlined, ApartmentOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { dataObjectTitle, shortDataIdentity, type DataFlowNeighbor, type DataFlowObject } from "./DataFlowModel.js";
import "@xyflow/react/dist/style.css";

type FlowNode = Node<{ object: DataFlowObject; focus: boolean; direction: string }>;
function DataNode({ data }: NodeProps<FlowNode>) {
  const subject = data.object.subject;
  return <div className={`data-node${data.focus ? " data-node-focus" : ""}`} title={`${subject.owner} / ${subject.kind}\n${subject.id}\nRevision: ${subject.revision ?? "Not revisioned"}`}>
    <Handle type="target" position={Position.Left} />
    <div className="data-node-kind"><span>{subject.kind}</span><span>{subject.revision ? `rev ${subject.revision}` : data.direction}</span></div>
    <strong>{dataObjectTitle(data.object)}</strong>
    <small>{subject.owner}{data.object.availability !== "present" ? " / not observed" : ""}</small>
    <code>{shortDataIdentity(subject)}</code>
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { data: DataNode };
const pageSize = 3;
function NeighborPage({ label, count, page, onChange }: { label: string; count: number; page: number; onChange: (page: number) => void }) {
  return <div className="data-direction"><strong>{label}</strong><span>{count ? `${page * pageSize + 1}-${Math.min(count, (page + 1) * pageSize)} / ${count}` : "0"}</span>
    <Button type="text" size="small" aria-label={`Previous ${label.toLowerCase()}`} disabled={page === 0} icon={<LeftOutlined />} onClick={() => onChange(page - 1)} />
    <Button type="text" size="small" aria-label={`Next ${label.toLowerCase()}`} disabled={(page + 1) * pageSize >= count} icon={<RightOutlined />} onClick={() => onChange(page + 1)} />
  </div>;
}

export function DataFlowGraph({ focus, incoming, outgoing, onFocus, onRelations }: {
  focus: DataFlowObject; incoming: DataFlowNeighbor[]; outgoing: DataFlowNeighbor[];
  onFocus: (subject: InspectionSubjectRef) => void; onRelations: (links: InspectionLink[]) => void;
}) {
  const [inPage, setInPage] = useState(0);
  const [outPage, setOutPage] = useState(0);
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const incomingPage = Math.min(inPage, Math.max(0, Math.ceil(incoming.length / pageSize) - 1));
  const outgoingPage = Math.min(outPage, Math.max(0, Math.ceil(outgoing.length / pageSize) - 1));
  const layout = useMemo(() => {
    const left = incoming.slice(incomingPage * pageSize, (incomingPage + 1) * pageSize);
    const right = outgoing.slice(outgoingPage * pageSize, (outgoingPage + 1) * pageSize);
    const rows = Math.max(left.length, right.length, 1);
    const result: FlowNode[] = [{ id: "focus", type: "data", data: { object: focus, focus: true, direction: "Focus" }, position: { x: 370, y: (rows - 1) * 72 }, width: 246, height: 112 }];
    const edges: Edge[] = [];
    const groups = new Map<string, InspectionLink[]>();
    for (const [side, neighbors] of [["incoming", left], ["outgoing", right]] as const) {
      neighbors.forEach((neighbor, index) => {
        const id = `${side}:${neighbor.key}`;
        result.push({ id, type: "data", data: { object: neighbor.node, focus: false, direction: side }, position: { x: side === "incoming" ? 0 : 740, y: index * 144 + (rows - neighbors.length) * 72 }, width: 246, height: 112 });
        const kinds = [...new Set(neighbor.links.map(link => link.kind))];
        const omitted = kinds.every(kind => kind === "omits");
        const color = omitted ? "#a3692b" : side === "incoming" ? "#547a9c" : "#287d70";
        groups.set(id, neighbor.links);
        edges.push({ id, source: side === "incoming" ? id : "focus", target: side === "incoming" ? "focus" : id,
          type: "default", label: kinds.length === 1 ? `${kinds[0]}${neighbor.links.length > 1 ? ` (${neighbor.links.length})` : ""}` : `${neighbor.links.length} relations`,
          style: { stroke: color, strokeWidth: 1.8, strokeDasharray: omitted ? "5 4" : undefined },
          labelStyle: { fill: color, fontSize: 12 }, labelBgStyle: { fill: "#fff", fillOpacity: 0.96 }, labelBgPadding: [6, 4],
          markerEnd: { type: MarkerType.ArrowClosed, color }, interactionWidth: 24,
        });
      });
    }
    return { nodes: result, edges, groups };
  }, [focus, incoming, outgoing, incomingPage, outgoingPage]);
  useEffect(() => { setNodes(layout.nodes); }, [layout, setNodes]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void instance?.fitView({ padding: 0.1, minZoom: 0.3, maxZoom: 1 }); });
    return () => cancelAnimationFrame(frame);
  }, [layout, instance]);
  const reset = () => { setNodes(layout.nodes); void instance?.fitView({ padding: 0.1, maxZoom: 1 }); };
  return <div className="data-flow-canvas graph-surface" data-layout="ready">
    <div className="data-graph-toolbar"><NeighborPage label="Incoming" count={incoming.length} page={incomingPage} onChange={setInPage} />
      <div className="data-graph-actions"><Tooltip title="Reset layout"><Button aria-label="Auto layout" icon={<ApartmentOutlined />} onClick={reset} /></Tooltip>
        <Tooltip title="Fit neighborhood"><Button aria-label="Fit data flow" icon={<AimOutlined />} onClick={() => { void instance?.fitView({ padding: 0.1, maxZoom: 1 }); }} /></Tooltip></div>
      <NeighborPage label="Outgoing" count={outgoing.length} page={outgoingPage} onChange={setOutPage} /></div>
    <div className="data-graph-scroll"><div className="data-graph-viewport"><ReactFlow nodes={nodes} edges={layout.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onInit={setInstance}
      onNodeClick={(_event, node) => { if (!node.data.focus) onFocus(node.data.object.subject); }}
      onEdgeClick={(_event, edge) => onRelations(layout.groups.get(edge.id) ?? [])}
      nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={0.25} maxZoom={1.6} fitView fitViewOptions={{ padding: 0.1, maxZoom: 1 }}>
      <Background color="#e4e9ed" gap={20} /><Controls showInteractive={false} />
    </ReactFlow></div></div>
  </div>;
}
