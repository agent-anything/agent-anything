import { useEffect, useRef } from "react";
import { Select, Tag } from "antd";
import { Timeline, type DataItem, type DataGroup } from "vis-timeline/standalone";
import { DataSet } from "vis-data";
import type { InspectionTimelineInterval } from "@agent-anything/inspection/query";
import type { InspectionRecord } from "@agent-anything/inspection/records";
import { readInspectionViewState, rememberInspectionViewState, useInspectionViewState } from "../navigation/InspectionViewState.js";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";

export function ExecutionTimeline({intervals, runRecords, onRecord, scopeKey}: {
  intervals: readonly InspectionTimelineInterval[]; runRecords: readonly InspectionRecord[]; onRecord:(id:string)=>void; scopeKey:string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const selection = useRef(onRecord); selection.current = onRecord;
  const clocks = [...new Set(intervals.map(item=>item.clock))];
  const [chosenClock,setClock] = useInspectionViewState<string|null>(scopeKey+":clock",null);
  const clock = chosenClock && clocks.includes(chosenClock) ? chosenClock : clocks[0];
  const current = intervals.filter(item=>item.clock===clock);
  const laneKey = (item:InspectionTimelineInterval) => (item.subject.runId ?? "unowned") + ":" + item.activity;
  const lanes = [...new Set(current.map(laneKey))].slice(0,100);
  const visible = current.filter(item=>lanes.includes(laneKey(item))).slice(0,2000);
  useEffect(() => {
    if (!element.current || !visible.length) return;
    const runIds = [...new Set(visible.map(item=>item.subject.runId ?? "unowned"))];
    const parentGroups: DataGroup[] = runIds.map(id=>{
      const run = runRecords.find(r=>r.subject.id===id);
      const role = run?.payload.kind==="snapshot" ? run.payload.parentRunId ? "Child" : "Root" : "Run";
      return {id:"run:"+id,content:`${role} / ${id.slice(0,12)}`,nestedGroups:lanes.filter(lane=>lane.startsWith(id+":")),showNested:true};
    });
    const groups = new DataSet<DataGroup>([...parentGroups,...lanes.map(id=>({id,content:visible.find(item=>laneKey(item)===id)!.activity}))]);
    const items = new DataSet<DataItem>(visible.map(item=>({
      id:item.id,group:laneKey(item),content:`${item.subject.kind} ${item.subject.id.slice(0,8)} / ${item.status ?? (item.end ? "settled" : "open")}`,
      start:new Date(item.start),end:new Date(item.end ?? item.horizon),
      className:item.status && /fail|denied|cancel|error|reject/u.test(item.status) ? "interval-failed" : item.end ? "interval-settled" : "interval-open",
    })));
    const asText = (item:{content?:string}|null) => {const label=document.createElement("span"); label.textContent=item?.content ?? "";return label;};
    const timeline = new Timeline(element.current,items,groups,{height:"100%",editable:false,showCurrentTime:false,stack:true,zoomMin:100,horizontalScroll:true,verticalScroll:true,template:asText,groupTemplate:asText});
    const windowKey=scopeKey+":window:"+clock;
    const window=readInspectionViewState<{start:number;end:number}|null>(windowKey,null);
    if(window)timeline.setWindow(window.start,window.end,{animation:false});
    timeline.on("rangechanged",event=>{if(event.byUser)rememberInspectionViewState(windowKey,{start:event.start.valueOf(),end:event.end.valueOf()});});
    timeline.on("select",event=>{const item=visible.find(entry=>entry.id===event.items[0]); if(item) selection.current(item.endRecordId ?? item.startRecordId);});
    return ()=>{timeline.destroy();items.clear();groups.clear();};
  },[intervals,clock,runRecords,scopeKey]);
  return <div className="timeline-view"><div className="view-toolbar"><Select aria-label="Timeline clock" value={clock} options={clocks.map(value=>({value,label:value}))} onChange={setClock}/><Tag>{visible.length} intervals</Tag><span>Recorded source clock</span></div>
    {(current.length>visible.length) && <div className="coverage-note">Partial view: at most 100 lanes and 2,000 intervals.</div>}
    <div className="timeline-surface" ref={element} aria-label="Execution timeline"/>
  </div>;
}
