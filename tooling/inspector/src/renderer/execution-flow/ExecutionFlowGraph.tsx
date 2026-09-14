import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Tooltip } from "antd";
import { ApartmentOutlined, AimOutlined } from "@ant-design/icons";
import { ReactFlow, Background, Controls, Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath, MarkerType, type Node, type Edge, type NodeProps, type EdgeProps, type ReactFlowInstance, useNodesState } from "@xyflow/react";
import ELK from "elkjs/lib/elk-api";
import type { ElkExtendedEdge } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { InspectionRecord, InspectionLink } from "@agent-anything/inspection/records";
import type { InspectionFlowRead } from "@agent-anything/inspection/query";
import "@xyflow/react/dist/style.css";
import { readInspectionViewState, rememberInspectionViewState, useInspectionViewState } from "../navigation/InspectionViewState.js";

type Point = {x: number; y: number};
type GraphViewState = {positions: [string,Point][]; viewport?: {x:number;y:number;zoom:number}; selected?:string|null};
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

export function ExecutionFlowGraph({flow, selected, onSelect, occurrenceLinks = [], occurrenceId, relatedRecords = [], viewKey}: {flow: InspectionFlowRead; selected: string | null; onSelect: (id: string) => void; occurrenceLinks?: readonly InspectionLink[]; occurrenceId?: string|null; relatedRecords?: readonly InspectionRecord[]; viewKey:string}) {
  const capturedDefinition = flow.definition!;
  const [observedOnly, setObservedOnly] = useInspectionViewState(viewKey+":visited",true);
  const definition = useMemo(() => {
    if (!observedOnly) return capturedDefinition;
    const visited = new Set(flow.steps.filter(step=>step.visits>0).map(step=>step.stepId));
    return {...capturedDefinition,steps:capturedDefinition.steps.filter(step=>visited.has(step.id)),transitions:capturedDefinition.transitions.filter(edge=>visited.has(edge.from)&&visited.has(edge.to))};
  }, [capturedDefinition,flow.steps,observedOnly]);
  const layoutKey = definition.contentDigest + ":" + definition.steps.map(step=>step.id).join(",");
  const memoryKey=viewKey+":"+layoutKey;
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const [routes, setRoutes] = useState<Map<string, Point[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const instance = useRef<ReactFlowInstance<StepNode, Edge> | null>(null);
  const positions = useRef(new Map<string, Point>());
  const generation = useRef(0);
  const previousDefinition = useRef("");
  const focusedStep = useRef(readInspectionViewState<GraphViewState>(memoryKey,{positions:[]}).selected);
  const [ready, setReady] = useState(false);
  const counts = useMemo(() => new Map(flow.steps.map(step => [step.stepId, step])), [flow.steps]);
  useEffect(() => {
    if (previousDefinition.current !== layoutKey) {
      previousDefinition.current = layoutKey;
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
      const remembered=layoutRevision===0 ? readInspectionViewState<GraphViewState>(memoryKey,{positions:[]}) : {positions:[]} as GraphViewState;
      positions.current = new Map(result.children?.map(node => [node.id,{x:node.x ?? 0,y:node.y ?? 0}]));
      for(const [id,position] of remembered.positions) if(positions.current.has(id))positions.current.set(id,position);
      setNodes(current => current.map(node => ({...node,position:positions.current.get(node.id) ?? node.position})));
      setRoutes(new Map(result.edges?.flatMap(edge => { const section = (edge as ElkExtendedEdge).sections?.[0]; return section ? [[edge.id,[section.startPoint,...section.bendPoints ?? [],section.endPoint]]] : []; })));
      if(remembered.positions.length)setRoutes(new Map());
      setError(null);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if(disposed || !instance.current)return;
        const adjustment=remembered.viewport ? instance.current.setViewport(remembered.viewport) : instance.current.fitView({padding:0.2,maxZoom:1,minZoom:0.65,nodes:[{id:definition.entryStepIds.find(id=>positions.current.has(id)) ?? definition.steps[0]?.id ?? ""}]});
        void adjustment.then(()=>{if(!disposed)setReady(true);});
      }));
    }).catch(() => { if (!disposed) setError("Automatic layout unavailable. Recorded occurrences remain available."); }).finally(() => { clearTimeout(timer); elk.terminateWorker(); });
    return () => {disposed = true; clearTimeout(timer); elk.terminateWorker();};
  }, [memoryKey, layoutRevision, setNodes]);
  const edges: Edge[] = definition.transitions.map(edge => {
    const count = flow.transitions.find(item => item.transitionId === edge.id)?.traversals ?? 0;
    const highlighted = occurrenceLinks.some(link=>link.kind==="next" && link.operation===edge.id && (link.from.id===occurrenceId || link.to.id===occurrenceId));
    const color = highlighted ? "#156cb0" : count ? "#286958" : "#a6afb8";
    return {id:edge.id,source:edge.from,target:edge.to,type:"route",data:{route:routes.get(edge.id)},label:count ? String(count) : undefined,markerEnd:{type:MarkerType.ArrowClosed,color},style:{stroke:color,strokeWidth:highlighted ? 4 : count ? 2.4 : 1,strokeDasharray:count ? undefined : "5 5"}};
  });
  useEffect(() => {
    if (!selected || !ready || selected===focusedStep.current) return;
    focusedStep.current=selected;
    const position = positions.current.get(selected);
    if (position) void instance.current?.setCenter(position.x+110,position.y+44,{zoom:Math.max(0.75,instance.current.getZoom()),duration:160});
  }, [selected,ready]);
  const exactSteps = new Set(relatedRecords.flatMap(record=>record.payload.kind==="flow_step" && (record.subject.id===occurrenceId || occurrenceLinks.some(link=>link.kind==="next" && (link.from.id===record.subject.id || link.to.id===record.subject.id))) ? [record.payload.observation.stepId] : []));
  const displayNodes: StepNode[] = nodes.map(node=>({...node,className:occurrenceId && exactSteps.has(node.id)?"flow-node-path":undefined}));
  return <div className="flow-graph" data-layout={ready ? "ready" : "pending"}><div className="view-toolbar"><Tooltip title="Layout captured definition"><Button aria-label="Layout flow" icon={<ApartmentOutlined />} onClick={() => setLayoutRevision(value => value+1)} /></Tooltip><Tooltip title="Fit flow"><Button aria-label="Fit flow" icon={<AimOutlined />} onClick={() => {void instance.current?.fitView({padding:0.2,maxZoom:1});}} /></Tooltip><Checkbox checked={observedOnly} onChange={event=>setObservedOnly(event.target.checked)}>Visited steps</Checkbox><span className="flow-legend observed">Recorded path</span><span className="flow-legend declared">Declared path</span></div>{error && <Alert type="warning" title={error} />}
    <ReactFlow nodes={displayNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={value => {instance.current=value;}} onNodesChange={onNodesChange} onNodeDragStop={(_event,node) => {positions.current.set(node.id,node.position);setRoutes(new Map());rememberInspectionViewState(memoryKey,{positions:[...positions.current],viewport:instance.current?.getViewport(),selected});}} onMoveEnd={(_event,viewport)=>{if(ready)rememberInspectionViewState(memoryKey,{...readInspectionViewState<GraphViewState>(memoryKey,{positions:[]}),viewport,selected});}} onNodeClick={(_event,node) => onSelect(node.id)} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={0.08} maxZoom={2}><Background /><Controls showInteractive={false} /></ReactFlow>
  </div>;
}
