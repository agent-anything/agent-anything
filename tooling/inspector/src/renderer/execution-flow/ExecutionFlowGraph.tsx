import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Tooltip } from "antd";
import { ApartmentOutlined, AimOutlined } from "@ant-design/icons";
import { ReactFlow, Background, Controls, Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath, MarkerType, type Node, type Edge, type NodeProps, type EdgeProps, type ReactFlowInstance, useNodesState } from "@xyflow/react";
import ELK from "elkjs/lib/elk-api";
import type { ElkExtendedEdge } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { InspectionFlowRead } from "@agent-anything/inspection/query";
import "@xyflow/react/dist/style.css";

type Point = {x: number; y: number};
type StepNode = Node<{label: string; kind: string; visits: number; open: number; failed: number}>;
function Step({data}: NodeProps<StepNode>) {
  return <div className="flow-step-node"><Handle type="target" position={Position.Left} /><small>{data.kind}</small><strong>{data.label}</strong><span>{data.visits} visits{data.open > 0 ? ` / ${data.open} open` : ""}{data.failed ? ` / ${data.failed} failed` : ""}</span><Handle type="source" position={Position.Right} /></div>;
}
function Route(props: EdgeProps) {
  const route = (props.data as {route?: Point[]} | undefined)?.route;
  const fallback = getSmoothStepPath(props);
  const path = route?.length ? route.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ") : fallback[0];
  const center = route?.[Math.floor(route.length / 2)] ?? {x:fallback[1],y:fallback[2]};
  return <><BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} interactionWidth={20} />{props.label && <EdgeLabelRenderer><span className="flow-edge-count" style={{transform:`translate(-50%,-50%) translate(${center.x}px,${center.y}px)`}}>{props.label}</span></EdgeLabelRenderer>}</>;
}
const nodeTypes = {step: Step};
const edgeTypes = {route: Route};

export function ExecutionFlowGraph({flow, selected, onSelect}: {flow: InspectionFlowRead; selected: string | null; onSelect: (id: string) => void}) {
  const definition = flow.definition!;
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const [routes, setRoutes] = useState<Map<string, Point[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const instance = useRef<ReactFlowInstance<StepNode, Edge> | null>(null);
  const positions = useRef(new Map<string, Point>());
  const generation = useRef(0);
  const previousDefinition = useRef("");
  const [ready, setReady] = useState(false);
  const counts = useMemo(() => new Map(flow.steps.map(step => [step.stepId, step])), [flow.steps]);
  useEffect(() => {
    if (previousDefinition.current !== definition.contentDigest) {
      previousDefinition.current = definition.contentDigest;
      positions.current.clear();
      setRoutes(new Map());
    }
    setNodes(definition.steps.map((step, index) => {
      const count = counts.get(step.id);
      return {id:step.id,type:"step",position:positions.current.get(step.id) ?? {x:(index % 3)*270,y:Math.floor(index/3)*130},data:{label:step.label,kind:step.kind,visits:count?.visits ?? 0,open:Math.max(0,(count?.visits ?? 0)-(count?.exits ?? 0)),failed:count?.failed ?? 0},style:{width:220,height:88},selected:step.id === selected};
    }));
  }, [definition, counts, selected, setNodes]);
  useEffect(() => {
    const active = ++generation.current;
    const elk = new ELK({workerUrl:elkWorkerUrl});
    setReady(false);
    let disposed = false;
    const timer = setTimeout(() => { disposed = true; elk.terminateWorker(); setError("Layout timed out. Recorded occurrences remain available."); }, 5000);
    void elk.layout({id:"flow",layoutOptions:{"elk.algorithm":"layered","elk.direction":"RIGHT","elk.edgeRouting":"ORTHOGONAL","elk.layered.spacing.nodeNodeBetweenLayers":"110","elk.spacing.nodeNode":"70","elk.spacing.edgeNode":"35"},children:definition.steps.map(step => ({id:step.id,width:220,height:88,layoutOptions:{"elk.portConstraints":"FIXED_SIDE"},ports:[{id:`${step.id}:in`,layoutOptions:{"elk.port.side":"WEST"}},{id:`${step.id}:out`,layoutOptions:{"elk.port.side":"EAST"}}]})),edges:definition.transitions.map(edge => ({id:edge.id,sources:[`${edge.from}:out`],targets:[`${edge.to}:in`]}))}).then(result => {
      if (disposed || active !== generation.current) return;
      positions.current = new Map(result.children?.map(node => [node.id,{x:node.x ?? 0,y:node.y ?? 0}]));
      setNodes(current => current.map(node => ({...node,position:positions.current.get(node.id) ?? node.position})));
      setRoutes(new Map(result.edges?.flatMap(edge => { const section = (edge as ElkExtendedEdge).sections?.[0]; return section ? [[edge.id,[section.startPoint,...section.bendPoints ?? [],section.endPoint]]] : []; })));
      setError(null);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!disposed) void instance.current?.fitView({padding:0.2,maxZoom:1}).then(() => setReady(true)); }));
    }).catch(() => { if (!disposed) setError("Automatic layout unavailable. Recorded occurrences remain available."); }).finally(() => { clearTimeout(timer); elk.terminateWorker(); });
    return () => {disposed = true; clearTimeout(timer); elk.terminateWorker();};
  }, [definition.contentDigest, layoutRevision, setNodes]);
  const edges: Edge[] = definition.transitions.map(edge => {
    const count = flow.transitions.find(item => item.transitionId === edge.id)?.traversals ?? 0;
    const color = count ? "#286958" : "#a6afb8";
    return {id:edge.id,source:edge.from,target:edge.to,type:"route",data:{route:routes.get(edge.id)},label:count ? String(count) : undefined,markerEnd:{type:MarkerType.ArrowClosed,color},style:{stroke:color,strokeWidth:count ? 2.4 : 1,strokeDasharray:count ? undefined : "5 5"}};
  });
  return <div className="flow-graph" data-layout={ready ? "ready" : "pending"}><div className="view-toolbar"><Tooltip title="Layout captured definition"><Button aria-label="Layout flow" icon={<ApartmentOutlined />} onClick={() => setLayoutRevision(value => value+1)} /></Tooltip><Tooltip title="Fit flow"><Button aria-label="Fit flow" icon={<AimOutlined />} onClick={() => {void instance.current?.fitView({padding:0.2,maxZoom:1});}} /></Tooltip><span className="flow-legend observed">Recorded path</span><span className="flow-legend declared">Declared path</span></div>{error && <Alert type="warning" title={error} />}
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={value => {instance.current=value;}} onNodesChange={onNodesChange} onNodeDragStop={(_event,node) => {positions.current.set(node.id,node.position);setRoutes(new Map());}} onNodeClick={(_event,node) => onSelect(node.id)} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={0.08} maxZoom={2}><Background /><Controls showInteractive={false} /></ReactFlow>
  </div>;
}
