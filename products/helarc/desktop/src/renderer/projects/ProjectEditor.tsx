import * as React from "react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderPlus, Save, X } from "lucide-react";
import type { HelarcMainSnapshot, HelarcProjectSnapshot } from "../../shared/HelarcDesktopApi.js";

export function ProjectEditor({ project, snapshot, onSaved, onSnapshot, onClose }: {
  project: HelarcProjectSnapshot | null; snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot, id: string) => void;
  onSnapshot: (snapshot: HelarcMainSnapshot) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(project?.name ?? "");
  const [folders, setFolders] = useState<string[]>(project ? [project.primaryProfileId, ...project.additionalProfileIds] : []);
  const [primary, setPrimary] = useState(project?.primaryProfileId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const id = (kind: string) => `helarc-project-${kind}-${crypto.randomUUID()}`;
  async function chooseFolder() {
    setBusy(true); setError(null);
    try {
      const receipt = await window.helarc.chooseProjectFolder({ commandId: id("folder") });
      if (receipt.status !== "handled") { setError("Folder could not be selected."); return; }
      onSnapshot(receipt.result.snapshot);
      if (receipt.result.error) setError(receipt.result.error);
      const profile = receipt.result.profile;
      if (profile && !folders.includes(profile.id)) {
        setFolders([...folders, profile.id]);
        if (!primary) setPrimary(profile.id);
        if (!name.trim()) setName(profile.displayName);
      }
    } catch { setError("Folder could not be selected."); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const receipt = await window.helarc.saveProject({ commandId: id("save"), id: project?.id ?? null,
        expectedRevision: project?.revision ?? null, name, primaryProfileId: primary,
        additionalProfileIds: folders.filter((folder) => folder !== primary) });
      if (receipt.status !== "handled") { setError("Project could not be saved."); return; }
      onSnapshot(receipt.result.snapshot);
      if (!receipt.result.ok) { setError(receipt.result.error); return; }
      const saved = project ? receipt.result.snapshot.projects.find((item) => item.id === project.id)
        : receipt.result.snapshot.projects.find((item) => !snapshot.projects.some((previous) => previous.id === item.id));
      if (saved) onSaved(receipt.result.snapshot, saved.id);
    } catch { setError("Project could not be saved."); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="project-editor" aria-labelledby="project-editor-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => void save(event)}>
      <header><h2 id="project-editor-title">{project ? "Project settings" : "New project"}</h2><button type="button" className="wb-icon" aria-label="Close project settings" title="Close" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <label className="project-name">Name<input name="projectName" autoFocus required maxLength={200} value={name} disabled={busy} onChange={(event) => setName(event.target.value)}/></label>
      <div className="project-folders-heading"><h3>Folders</h3><button type="button" className="project-add-folder" onClick={() => void chooseFolder()} disabled={busy || folders.length >= 64}><FolderPlus size={16}/>Add folder</button></div>
      <div className="project-folder-list">{folders.map((folderId) => {
        const profile = snapshot.workspaceProfiles.find((item) => item.id === folderId);
        return <div key={folderId} className="project-folder">
          <label title="Default working directory"><input type="radio" name="primaryFolder" aria-label={`Primary folder: ${profile?.displayName ?? folderId}`} checked={primary === folderId} disabled={busy} onChange={() => setPrimary(folderId)}/><span><strong>{profile?.displayName ?? "Unavailable folder"}</strong><small>{profile?.path ?? folderId}</small></span></label>
          {primary === folderId && <span className="project-primary">Primary</span>}
          <button type="button" className="wb-icon" title={primary === folderId ? "Choose another primary folder before removing this folder" : "Remove folder"} aria-label={`Remove ${profile?.displayName ?? folderId}`} disabled={busy || primary === folderId} onClick={() => setFolders(folders.filter((item) => item !== folderId))}><X size={15}/></button>
        </div>;
      })}</div>
      {snapshot.selectedProjectId === project?.id && snapshot.run && !snapshot.run.display.terminal && <p className="project-notice">Folder changes apply to new work. Current work keeps its folders.</p>}
      {error && <p className="wb-warning" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy || !name.trim() || !primary}><Save size={15}/>{busy ? "Saving..." : "Save"}</button></footer>
    </form>
  </dialog>;
}
