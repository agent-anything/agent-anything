import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, BaseEdge, EdgeLabelRenderer, Handle, Position, MarkerType, getSmoothStepPath, useNodesState, useEdgesState, type EdgeProps, type NodeProps, type Node, type Edge, type ReactFlowInstance } from "@xyflow/react";
import ELK from "elkjs/lib/elk-api";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { Button, Alert, Tooltip, Switch } from "antd";
import { ApartmentOutlined, MinusSquareOutlined, PlusSquareOutlined, AimOutlined } from "@ant-design/icons";
import { inspectionSubjectKey, type InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionGraph } from "@agent-anything/inspection/query";
import "@xyflow/react/dist/style.css";

type Point = { x: number; y: number };
type ObjectNode = Node<{ title: string; owner: string; kind: string; group: boolean; folded: boolean; toggle: () => void; availability: string }>;
function RecordedNode({ data }: NodeProps<ObjectNode>) {
  return <div className={"recorded-node " + (data.group ? "recorded-group" : "")}>
    <Handle type="target" position={Position.Left} />
    <div className="graph-node"><strong>{data.kind}{data.group && <Button className="nodrag" size="small" type="text" aria-label={data.folded ? "Expand " + data.title : "Collapse " + data.title} icon={data.folded ? <PlusSquareOutlined /> : <MinusSquareOutlined />} onClick={(event) => { event.stopPropagation(); data.toggle(); }} />}</strong>
      <span title={data.title}>{data.title}</span><small>{data.owner}{data.availability !== "present" ? " / not observed" : ""}</small></div>
    <Handle type="source" position={Position.Right} />
  </div>;
}
function EvidenceEdge(props: EdgeProps) {
  const data = props.data as { route?: Point[]; ordinal?: number; folded?: boolean } | undefined;
  const fallback = getSmoothStepPath({ ...props, offset: 24 + (data?.ordinal ?? 0) * 18 });
  const route = data?.route;
  const path = route?.length ? route.map((point, index) => (index ? "L" : "M") + point.x + "," + point.y).join(" ") : fallback[0];
  const segments = route?.slice(1).map((end, index) => ({ start: route[index]!, end }));
  const longest = segments?.sort((a, b) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) - Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y))[0];
  const middle = longest ? { x: (longest.start.x + longest.end.x) / 2, y: (longest.start.y + longest.end.y) / 2 } : { x: fallback[1], y: fallback[2] };
  return <><BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={24} /><EdgeLabelRenderer>
    <div className={"edge-label nodrag nopan " + (props.selected ? "selected" : "")} style={{ transform: "translate(-50%, -50%) translate(" + middle.x + "px," + (middle.y - (data?.ordinal ?? 0) * 16) + "px)" }}>{props.label}{data?.folded ? " *" : ""}</div>
  </EdgeLabelRenderer></>;
}
const nodeTypes = { recorded: RecordedNode };
const edgeTypes = { evidence: EvidenceEdge };

export function RelationGraph({ graph, selected, onSelect, onLink }: { graph: InspectionGraph; selected: InspectionSubjectRef | null; onSelect: (subject: InspectionSubjectRef) => void; onLink: (id: string) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ObjectNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const geometry = useRef(new Map<string, { position: Point; width: number; height: number }>());
  const instance = useRef<ReactFlowInstance<ObjectNode, Edge> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const generation = useRef(0);
  const initialLayout = useRef("");
  const routesCache = useRef(new Map<string, Point[]>());
  const worker = useRef<InstanceType<typeof ELK> | null>(null);
  const tree = useMemo(() => {
    const originals = new Map(graph.nodes.map((node) => [inspectionSubjectKey(node.subject), node]));
    const parents = new Map<string, string>();
    const runs = new Map(graph.nodes.filter((node) => node.subject.kind === "run").map((node) => [node.subject.id, inspectionSubjectKey(node.subject)]));
    if (grouped) {
      for (const [id, node] of originals) {
        const parent = node.subject.runId ? runs.get(node.subject.runId) : null;
        if (parent && parent !== id) parents.set(id, parent);
      }
      for (const link of graph.links) if (link.kind === "descendant") {
        const from = inspectionSubjectKey(link.from); const to = inspectionSubjectKey(link.to);
        let ancestor: string | undefined = from; const seen = new Set([to]);
        while (ancestor && !seen.has(ancestor)) { seen.add(ancestor); ancestor = parents.get(ancestor); }
        if (!ancestor && originals.has(from) && originals.has(to)) parents.set(to, from);
      }
    }
    const representative = (id: string) => {
      let result = id; let parent = parents.get(id); const seen = new Set([id]);
      while (parent && !seen.has(parent)) { seen.add(parent); if (collapsed.has(parent)) result = parent; parent = parents.get(parent); }
      return result;
    };
    const order = [...originals.keys()].filter((id) => representative(id) === id).sort((left, right) => {
      const depth = (id: string) => { let count = 0; while (parents.has(id) && count < 300) { id = parents.get(id)!; count++; } return count; };
      return depth(left) - depth(right);
    });
    return { originals, parents, representative, order };
  }, [graph, grouped, collapsed]);

  const visibleEdges = useMemo(() => {
    const ordinals = new Map<string, number>();
    return graph.links.flatMap((link): Edge[] => {
      const actualFrom = inspectionSubjectKey(link.from); const actualTo = inspectionSubjectKey(link.to);
      const source = tree.representative(actualFrom); const target = tree.representative(actualTo);
      if (source === target && actualFrom !== actualTo) return [];
      if ((link.kind === "contains" || link.kind === "descendant") && tree.parents.get(target) === source && !collapsed.has(source)) return [];
      const pair = source + ":" + target;
      const ordinal = ordinals.get(pair) ?? 0; ordinals.set(pair, ordinal + 1);
      const color = link.kind === "prerequisite" ? "#a55b19" : link.kind === "materializes" ? "#4772a2" : "#49716a";
      return [{ id: link.id, source, target, type: "evidence", markerEnd: { type: MarkerType.ArrowClosed, color },
        label: link.condition ? link.kind + ": " + link.condition : link.kind,
        data: { ordinal, folded: source !== actualFrom || target !== actualTo },
        style: { stroke: color, strokeWidth: 1.7 }, interactionWidth: 24, zIndex: 10 }];
    });
  }, [graph, tree, collapsed]);

  useEffect(() => {
    setNodes(tree.order.map((id, index) => {
      const node = tree.originals.get(id)!;
      const group = [...tree.parents.values()].includes(id);
      const folded = collapsed.has(id);
      const prior = geometry.current.get(id);
      const parentId = tree.parents.get(id);
      return { id, type: "recorded", parentId, extent: parentId ? "parent" as const : undefined,
        position: prior?.position ?? { x: (index % 3) * 310 + 24, y: Math.floor(index / 3) * 130 + 90 },
        data: { title: node.record?.payload.kind === "definition" ? node.record.payload.name : node.record?.payload.kind === "flow_step" ? node.record.payload.observation.stepId : node.record?.payload.kind === "flow_invocation" ? node.record.payload.observation.definition.id : node.subject.id, owner: node.subject.owner, kind: node.subject.kind, group, folded, availability: node.availability,
          toggle: () => setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }) },
        style: { width: group && !folded ? prior?.width ?? 530 : 230, height: group && !folded ? prior?.height ?? 320 : 86 },
        selected: selected !== null && inspectionSubjectKey(selected) === id,
      };
    }));
    setEdges(visibleEdges.map((edge) => ({ ...edge, data: { ...edge.data, route: routesCache.current.get(edge.id) } })));
  }, [tree, selected, collapsed, setNodes, setEdges, visibleEdges]);

  const layout = useCallback(async () => {
    const active = ++generation.current;
    setLayoutReady(false);
    worker.current?.terminateWorker();
    const elk = new ELK({ workerUrl: elkWorkerUrl }); worker.current = elk;
    const algorithm = visibleEdges.length ? "layered" : "box";
    const timer = setTimeout(() => { elk.terminateWorker(); if (active === generation.current) { generation.current++; setError("Layout timed out. Select a smaller neighborhood."); } }, 2000);
    const elkNodes = new Map<string, ElkNode>(tree.order.map((id) => [id, { id, width: 230, height: 86,
      layoutOptions: { "elk.algorithm": algorithm, "elk.aspectRatio": "1.5", "elk.padding": "[top=110,left=28,bottom=28,right=28]", "elk.portConstraints": "FIXED_SIDE", "elk.spacing.portPort": "16", "elk.layered.spacing.nodeNodeBetweenLayers": "140", "elk.spacing.nodeNode": "65" },
      ports: [],
    }]));
    for (const edge of visibleEdges) {
      elkNodes.get(edge.source)?.ports?.push({ id: edge.id + ":out", layoutOptions: { "elk.port.side": "EAST" } });
      elkNodes.get(edge.target)?.ports?.push({ id: edge.id + ":in", layoutOptions: { "elk.port.side": "WEST" } });
    }
    const root: ElkNode = { id: "inspection", layoutOptions: { "elk.algorithm": algorithm, "elk.aspectRatio": "1.5", "elk.direction": "RIGHT", "elk.hierarchyHandling": visibleEdges.length ? "INCLUDE_CHILDREN" : "SEPARATE_CHILDREN", "elk.spacing.nodeNode": "65", "elk.layered.spacing.nodeNodeBetweenLayers": "160", "elk.edgeRouting": "ORTHOGONAL" }, children: [],
      edges: visibleEdges.map((edge) => ({ id: edge.id, sources: [edge.id + ":out"], targets: [edge.id + ":in"] })),
    };
    for (const [id, node] of elkNodes) { const parent = tree.parents.get(id); const container = parent ? elkNodes.get(parent) ?? root : root; (container.children ??= []).push(node); }
    try {
      const result = await elk.layout(root);
      if (active !== generation.current) return;
      const routes = new Map<string, Point[]>();
      const offsets = new Map<string, Point>();
      const routed: { edge: ElkExtendedEdge; container: string }[] = [];
      const collect = (container: ElkNode, offset: Point) => {
        offsets.set(container.id, offset);
        for (const edge of (container.edges ?? []) as ElkExtendedEdge[]) {
          routed.push({ edge, container: edge.container ?? container.id });
        }
        for (const child of container.children ?? []) {
          const position = { x: child.x ?? 0, y: child.y ?? 0 };
          geometry.current.set(child.id, { position, width: child.width ?? 230, height: child.height ?? 86 });
          collect(child, { x: offset.x + position.x, y: offset.y + position.y });
        }
      };
      collect(result, { x: 0, y: 0 });
      // ELK can retain an edge at the root while reporting its coordinates in a nested container.
      for (const { edge, container } of routed) {
        const section = edge.sections?.[0]; const offset = offsets.get(container);
        if (section && offset) routes.set(edge.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })));
      }
      routesCache.current = routes;
      setNodes((items) => items.map((node) => { const box = geometry.current.get(node.id)!; return { ...node, position: box.position, style: { ...node.style, width: box.width, height: box.height } }; }));
      setEdges(visibleEdges.map((edge) => ({ ...edge, data: { ...edge.data, route: routes.get(edge.id) } })));
      setError(null);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (active === generation.current) void instance.current?.fitView({ padding: 0.15, maxZoom: 1.1, minZoom: 0.65, ...(selected ? {nodes:[{id:tree.representative(inspectionSubjectKey(selected))}]} : {}) }).then(() => { if (active === generation.current) setLayoutReady(true); });
      }));
    } catch { if (active === generation.current) setError("Automatic layout unavailable; relationships remain inspectable."); }
    finally { clearTimeout(timer); elk.terminateWorker(); }
  }, [tree, visibleEdges, setNodes, setEdges]);

  const topology = JSON.stringify([tree.order.map((id) => [id, tree.parents.get(id)]), visibleEdges.map((edge) => [edge.id, edge.source, edge.target])]);
  useEffect(() => { if (graph.nodes.length && initialLayout.current !== topology) { initialLayout.current = topology; routesCache.current.clear(); void layout(); } }, [graph, layout, topology]);
  useEffect(() => () => { generation.current++; worker.current?.terminateWorker(); }, []);
  return <div className="graph-surface" data-layout={layoutReady ? "ready" : "pending"}><div className="view-toolbar">
    <Tooltip title="Auto layout"><Button aria-label="Auto layout" icon={<ApartmentOutlined />} onClick={() => { void layout(); }} /></Tooltip>
    <Tooltip title="Focus selected object"><Button aria-label="Focus selected object" icon={<AimOutlined />} disabled={!selected} onClick={() => { if (selected) void instance.current?.fitView({ nodes: [{ id: tree.representative(inspectionSubjectKey(selected)) }], maxZoom: 1.5, padding: 0.3 }); }} /></Tooltip>
    <Switch size="small" checked={grouped} onChange={setGrouped} aria-label="Group by Run" /><span>Run groups</span>
    <span>{graph.nodes.length} objects / {graph.links.length} recorded relations</span>{graph.limited && <span>Limited neighborhood</span>}
  </div>{error && <Alert type="warning" title={error} />}
  <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(value) => { instance.current = value; }}
    onNodesChange={(changes) => { onNodesChange(changes); if (changes.some((change) => change.type === "position" && change.dragging)) { routesCache.current.clear(); setEdges((current) => current.map((edge) => ({ ...edge, data: { ...edge.data, route: undefined } }))); } }}
    onEdgesChange={onEdgesChange} onNodeDragStop={(_event, node) => geometry.current.set(node.id, { position: node.position, width: node.measured?.width ?? 230, height: node.measured?.height ?? 86 })}
    onNodeClick={(_event, node) => { const original = tree.originals.get(node.id); if (original) onSelect(original.subject); }}
    onEdgeClick={(_event, edge) => onLink(edge.id)} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} fitView minZoom={0.08} maxZoom={2}>
    <Background /><Controls showInteractive={false} />
  </ReactFlow></div>;
}
