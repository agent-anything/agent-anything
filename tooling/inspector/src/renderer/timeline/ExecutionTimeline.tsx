import { useEffect, useRef } from "react";
import { Timeline, type DataItem, type DataGroup } from "vis-timeline/standalone";
import { DataSet } from "vis-data";
import type { InspectionTimelineInterval } from "@agent-anything/inspection/query";
import { inspectionSubjectKey, type InspectionSubjectRef } from "@agent-anything/inspection/records";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";

export function ExecutionTimeline({ intervals, onSelect }: { intervals: readonly InspectionTimelineInterval[]; onSelect: (subject: InspectionSubjectRef) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const selection = useRef(onSelect); selection.current = onSelect;
  const window = useRef<{ start: Date; end: Date } | null>(null);
  useEffect(() => {
    if (!element.current || intervals.length === 0) return;
    const laneKey = (item: InspectionTimelineInterval) => item.clock + ":" + inspectionSubjectKey(item.subject);
    const lanes = [...new Set(intervals.map(laneKey))].slice(0, 100);
    const visible = intervals.filter((item) => lanes.includes(laneKey(item))).slice(0, 2000);
    const groups = new DataSet<DataGroup>(lanes.map((id) => { const item = visible.find((entry) => laneKey(entry) === id)!; return { id, content: item.subject.owner + ": " + item.subject.id + " / " + item.clock }; }));
    const items = new DataSet<DataItem>(visible.map((item) => ({ id: item.id, group: laneKey(item), content: `${item.activity}${item.end === null ? " (end not recorded)" : ""}`, start: new Date(item.start), end: new Date(item.end ?? item.horizon), className: item.end === null ? "interval-open" : "interval-settled" })));
    const asText = (item: { content?: string } | null) => { const label = document.createElement("span"); label.textContent = item?.content ?? ""; return label; };
    const timeline = new Timeline(element.current, items, groups, { height: "100%", editable: false, showCurrentTime: false, stack: true, zoomMin: 100, horizontalScroll: true, verticalScroll: true, template: asText, groupTemplate: asText, tooltip: { followMouse: false } });
    timeline.on("select", (event) => { const item = visible.find((entry) => entry.id === event.items[0]); if (item) selection.current(item.subject); });
    if (window.current) timeline.setWindow(window.current.start, window.current.end, { animation: false });
    return () => { window.current = timeline.getWindow(); timeline.destroy(); items.clear(); groups.clear(); };
  }, [intervals]);
  const limited = intervals.length > 2000 || new Set(intervals.map((item) => item.clock + ":" + inspectionSubjectKey(item.subject))).size > 100;
  return <>{limited && <div className="coverage-note">Partial view: at most 100 lanes and 2,000 intervals.</div>}<div className="timeline-surface" ref={element} aria-label="Execution timeline" /></>;
}
