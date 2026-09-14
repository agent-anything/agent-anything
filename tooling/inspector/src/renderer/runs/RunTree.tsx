import { Tree, Tag, Empty } from "antd";
import type { DataNode } from "antd/es/tree";
import type { InspectionRecord, InspectionSubjectRef } from "@agent-anything/inspection/records";
import { useInspectionViewState } from "../navigation/InspectionViewState.js";

export const shortIdentity = (id: string) => id.length > 18 ? `${id.slice(0, 12)}...` : id;

export function buildRunTree(records: readonly InspectionRecord[]): {record: InspectionRecord; children: string[]; root: boolean; issue: string | null}[] {
  const runs = new Map(records.filter(r => r.payload.kind === "snapshot").map(record => [record.subject.id, record]));
  const entries = [...runs.values()].map(record => {
    const parent = record.payload.kind === "snapshot" ? record.payload.parentRunId : null;
    let cursor = parent; const visited = new Set([record.subject.id]); let issue: string | null = null;
    while (cursor) {
      if (visited.has(cursor)) {issue = "Cyclic parent reference"; break;}
      visited.add(cursor); const ancestor = runs.get(cursor);
      if (!ancestor) {issue = "Parent outside loaded scope"; break;}
      cursor = ancestor.payload.kind === "snapshot" ? ancestor.payload.parentRunId : null;
    }
    return {record, children: [] as string[], root: !parent || issue !== null, issue};
  });
  for (const entry of entries) if (!entry.root && entry.record.payload.kind === "snapshot") {
    const parentId = entry.record.payload.parentRunId;
    entries.find(item => item.record.subject.id === parentId)?.children.push(entry.record.subject.id);
  }
  return entries;
}

export function RunTree({records, selected, search, onSelect}: {records: readonly InspectionRecord[]; selected?: string; search: string; onSelect: (subject: InspectionSubjectRef) => void}) {
  const entries = buildRunTree(records);
  const scope=records[0]?.subject;
  const [collapsed,setCollapsed]=useInspectionViewState<string[]>(`run-tree:${scope?.sourceId}:${scope?.datasetId}`,[]);
  const nodes = (entry: typeof entries[number]): DataNode => {
    const p = entry.record.payload;
    return {key: entry.record.subject.id, title: <div className="run-tree-label" title={entry.record.subject.id}>
      <strong>{p.kind === "snapshot" ? p.parentRunId ? "Child Run" : "Root Run" : "Run"}</strong>
      <Tag>{p.kind === "snapshot" ? p.status : "Unknown"}</Tag>
      <span>{p.kind === "snapshot" ? p.agentId ?? "Agent not recorded" : ""}</span><code>{shortIdentity(entry.record.subject.id)}</code>
      {entry.issue && <small className="run-tree-warning">{entry.issue}</small>}
    </div>, children: entry.children.map(id => nodes(entries.find(item => item.record.subject.id === id)!))};
  };
  const filter = search.trim().toLowerCase();
  const matches = (node: DataNode): boolean => {
    const record = entries.find(e => e.record.subject.id === node.key)?.record;
    return JSON.stringify(record?.payload).toLowerCase().includes(filter) || String(node.key).toLowerCase().includes(filter) || !!node.children?.some(matches);
  };
  const prune = (node: DataNode): DataNode => ({...node, children: node.children?.filter(matches).map(prune)});
  const tree = entries.filter(entry => entry.root).map(nodes).filter(matches).map(prune);
  return tree.length ? <Tree className="run-tree" blockNode expandedKeys={entries.filter(entry=>filter || !collapsed.includes(entry.record.subject.id)).map(entry=>entry.record.subject.id)} onExpand={keys=>setCollapsed(entries.filter(entry=>!keys.includes(entry.record.subject.id)).map(entry=>entry.record.subject.id))} selectedKeys={selected ? [selected] : []} treeData={tree}
    onSelect={keys => {const record = entries.find(item => item.record.subject.id === keys[0])?.record; if (record) onSelect(record.subject);}} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No Runs in loaded scope" />;
}
