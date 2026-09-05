import {
  createDefaultHelarcInstructionSettings,
  snapshotHelarcInstructionSettings,
  type HelarcInstructionSettings,
} from "@agent-anything/helarc/configuration";
import { SerializedAtomicFile, type SerializedAtomicFileOptions } from "../persistence/SerializedAtomicFile.js";

export class FileHelarcInstructionSettingsStore {
  private readonly file: SerializedAtomicFile;

  constructor(path: string, options: SerializedAtomicFileOptions = {}) {
    this.file = new SerializedAtomicFile(path, options);
  }

  async load(): Promise<HelarcInstructionSettings> {
    return this.file.transact(async (file) => readSettings(await file.readText()));
  }

  async save(candidate: unknown): Promise<HelarcInstructionSettings> {
    const settings = snapshotHelarcInstructionSettings(candidate);
    await this.file.transact(async (file) => {
      readSettings(await file.readText());
      await file.replaceText(JSON.stringify({ formatVersion: 2, settings }, null, 2));
    });
    return settings;
  }
}

function readSettings(text: string | null): HelarcInstructionSettings {
  if (text === null) return createDefaultHelarcInstructionSettings();
  const document: unknown = JSON.parse(text);
  if (document === null || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).length !== 2 || !("formatVersion" in document) ||
      document.formatVersion !== 2 || !("settings" in document)) {
    throw new TypeError("Instruction settings document version or shape is invalid.");
  }
  return snapshotHelarcInstructionSettings(document.settings);
}
