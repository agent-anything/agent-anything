import * as React from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, LoaderCircle, MessageSquare, Plus, Settings2, X } from "lucide-react";
import type { HelarcMainSnapshot, HelarcProjectSnapshot, HelarcThreadSummarySnapshot } from "../../shared/HelarcDesktopApi.js";

export function ProjectNavigation({ snapshot, busy, active, onOpen, onNew, onEdit, onClose }: {
  snapshot: HelarcMainSnapshot; busy: boolean; active: boolean;
  onOpen: (id: string) => void; onNew: (id: string) => void;
  onEdit: (project: HelarcProjectSnapshot | null) => void; onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  function conversation(thread: HelarcThreadSummarySnapshot) {
    const isWorking = snapshot.activeThread?.id === thread.id && !!snapshot.run &&
      !snapshot.run.display.terminal &&
      (snapshot.run.display.status === "starting" || snapshot.run.display.status === "running" || snapshot.run.display.status === "cancelling");
    return <button key={thread.id} type="button" className="project-conversation"
      title={isWorking ? `${thread.title} (In progress)` : thread.title}
      aria-busy={isWorking} aria-current={snapshot.activeThread?.id === thread.id ? "page" : undefined}
      disabled={busy || (active && snapshot.activeThread?.id !== thread.id)} onClick={() => onOpen(thread.id)}>
      {isWorking ? <LoaderCircle size={14} className="project-conversation-spinner" aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}
      <span>{thread.title}</span>
    </button>;
  }
  return <nav className="project-navigation" aria-label="Projects and conversations">
    <header className="wb-panel-header"><strong>Projects</strong><div className="project-actions">
      <button type="button" className="wb-icon" title="Add project" aria-label="Add project" onClick={() => onEdit(null)}><FolderPlus size={17}/></button>
      <button type="button" className="wb-icon" title="Close projects" aria-label="Close projects" onClick={onClose}><X size={17}/></button>
    </div></header>
    <div className="project-navigation-scroll">
      {snapshot.projects.map((project) => <section key={project.id} className="project-group">
        <div className="project-row" data-selected={snapshot.selectedProjectId === project.id}>
          <button className="project-heading" type="button" aria-expanded={!collapsed.has(project.id)} title={project.name}
            onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; })}>
            {collapsed.has(project.id) ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<Folder size={15}/><span>{project.name}</span>
          </button>
          <button type="button" className="wb-icon" title={`New conversation in ${project.name}`} aria-label={`New conversation in ${project.name}`} disabled={busy || active} onClick={() => onNew(project.id)}><Plus size={15}/></button>
          <button type="button" className="wb-icon" title={`Edit ${project.name}`} aria-label={`Edit ${project.name}`} onClick={() => onEdit(project)}><Settings2 size={14}/></button>
        </div>
        {!collapsed.has(project.id) && <div className="project-conversations">
          {snapshot.threadSummaries.filter((thread) => thread.projectId === project.id).map(conversation)}
          {!snapshot.threadSummaries.some((thread) => thread.projectId === project.id) && <button type="button" className="project-conversation" disabled={busy || active} onClick={() => onNew(project.id)}><Plus size={14}/>New conversation</button>}
        </div>}
      </section>)}
      {snapshot.projects.length === 0 && <button type="button" className="project-conversation" onClick={() => onEdit(null)}><FolderPlus size={16}/>Add project</button>}
      {snapshot.threadSummaries.some((thread) => thread.projectId === null) && <section className="project-group"><h3>Conversations</h3>{snapshot.threadSummaries.filter((thread) => thread.projectId === null).map(conversation)}</section>}
    </div>
  </nav>;
}
