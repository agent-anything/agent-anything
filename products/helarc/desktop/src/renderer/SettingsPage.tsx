import { X } from "lucide-react";
import * as React from "react";
import { InstructionSettingsPanel } from "./InstructionSettingsPanel.js";
import { InspectionSettingsPanel } from "./InspectionSettingsPanel.js";
import { StorageSettingsPanel } from "./StorageSettingsPanel.js";
import { ProviderSettingsPanel } from "./provider/ProviderSettingsPanel.js";
import { useState } from "react";
import type { HelarcMainSnapshot } from "../shared/HelarcDesktopApi.js";
export function SettingsPage({
  snapshot,
  onSaved,
  onClose,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <h1 id="settings-title">Settings</h1>
        <button
          className="secondary-button settings-close"
          type="button"
          onClick={onClose}
          title="Close settings"
          aria-label="Close settings"
          autoFocus
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <main className="settings-page-body" aria-labelledby="settings-title">
        <SettingsPanel snapshot={snapshot} onSaved={onSaved} />
      </main>
    </div>
  );
}

export function SettingsPanel({
  snapshot,
  onSaved,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
}) {
  const [tab, setTab] = useState<"provider" | "instructions" | "inspection" | "storage">(
    "provider",
  );
  const [instructionsOpened, setInstructionsOpened] = useState(false);
  return (
    <div className="settings-content">
      <div className="settings-tabs" role="tablist" aria-label="Settings">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "provider"}
          onClick={() => setTab("provider")}
        >
          Provider
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "instructions"}
          onClick={() => {
            setInstructionsOpened(true);
            setTab("instructions");
          }}
        >
          Instructions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "inspection"}
          onClick={() => setTab("inspection")}
        >
          Inspection
        </button>
        <button type="button" role="tab" aria-selected={tab === "storage"} onClick={() => setTab("storage")}>
          Storage
        </button>
      </div>
      <div hidden={tab !== "provider"}>
        <ProviderSettingsPanel snapshot={snapshot} onSaved={onSaved} />
      </div>
      <div hidden={tab !== "instructions"}>
        {instructionsOpened && (
          <InstructionSettingsPanel api={getHelarcApi()} />
        )}
      </div>
      {tab === "inspection" && <InspectionSettingsPanel api={getHelarcApi()} />}
      {tab === "storage" && <StorageSettingsPanel api={getHelarcApi()} />}
    </div>
  );
}


function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}
