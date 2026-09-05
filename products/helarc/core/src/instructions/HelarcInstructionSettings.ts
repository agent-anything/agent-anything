import { createHash } from "node:crypto";
import { createAgentInstructions } from "@agent-anything/agent-core/agent";
import type { HelarcInstructionTarget } from "./HelarcInstructionCatalog.js";
import {
  HELARC_DEFAULT_AGENT_INSTRUCTIONS,
  HELARC_DEFAULT_DELEGATED_INSTRUCTIONS,
} from "./HelarcInstructionReleases.js";
import {
  HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
  type HelarcInstructionSectionSetting,
} from "./HelarcProtocolInstructions.js";
import { HELARC_DEFAULT_STOP_INSTRUCTIONS } from "./HelarcStopInstructions.js";

export interface HelarcInstructionSettings {
  readonly agent: readonly HelarcInstructionSectionSetting[];
  readonly delegated: readonly HelarcInstructionSectionSetting[];
  readonly protocol: readonly HelarcInstructionSectionSetting[];
  readonly stop: readonly HelarcInstructionSectionSetting[];
}

export function createDefaultHelarcInstructionSettings(): HelarcInstructionSettings {
  return Object.freeze({
    agent: HELARC_DEFAULT_AGENT_INSTRUCTIONS,
    delegated: HELARC_DEFAULT_DELEGATED_INSTRUCTIONS,
    protocol: HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
    stop: HELARC_DEFAULT_STOP_INSTRUCTIONS,
  });
}

export function snapshotHelarcInstructionSettings(value: unknown): HelarcInstructionSettings {
  if (!isRecord(value) || Object.keys(value).length !== 4) {
    throw new TypeError("Instruction settings require agent, delegated, protocol, and stop sections.");
  }
  const record = value;
  const defaults = createDefaultHelarcInstructionSettings();
  function group(key: keyof HelarcInstructionSettings) {
    const candidates = record[key];
    if (!Array.isArray(candidates) || candidates.length !== defaults[key].length) {
      throw new TypeError(`Instruction settings ${key} sections are invalid.`);
    }
    const seen = new Set<string>();
    for (const entry of candidates) {
      if (!isRecord(entry) || Object.keys(entry).length !== 3 ||
          typeof entry.id !== "string" || seen.has(entry.id) ||
          !defaults[key].some(({ id }) => id === entry.id) ||
          typeof entry.enabled !== "boolean" || typeof entry.content !== "string" ||
          entry.content.length > 32_768 || entry.content.includes("\0")) {
        throw new TypeError(`Instruction settings ${key} entry is invalid.`);
      }
      seen.add(entry.id);
    }
    return Object.freeze(defaults[key].map(({ id }) => {
      const entry = candidates.find((candidate) => candidate.id === id)!;
      return Object.freeze({ id, enabled: entry.enabled as boolean, content: entry.content as string });
    }));
  }
  return Object.freeze({ agent: group("agent"), delegated: group("delegated"), protocol: group("protocol"), stop: group("stop") });
}

export function resolveConfiguredHelarcAgentInstructions(input: {
  readonly settings: HelarcInstructionSettings;
  readonly target: HelarcInstructionTarget;
  readonly agentId: string;
  readonly providerId: string;
  readonly modelId: string;
}) {
  const settings = snapshotHelarcInstructionSettings(input.settings);
  const entries = input.target === "delegated-worker"
    ? [...settings.agent, ...settings.delegated]
    : settings.agent;
  const blocks = entries.filter(({ enabled, content }) => enabled && content.trim().length > 0)
    .map(({ id, content }) => ({
      id,
      content,
      source: {
        owner: "helarc",
        kind: "product_agent_instruction_source",
        id: `helarc.instructions.configured.${id}`,
        revision: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
      },
    }));
  const releaseId = `helarc.instructions.configured.${input.target}`;
  const revision = `sha256:${createHash("sha256")
    .update(JSON.stringify({ id: releaseId, agentId: input.agentId, blocks }), "utf8").digest("hex")}`;
  return createAgentInstructions({
    id: `${input.agentId}.configured.instructions`,
    release: { id: releaseId, revision },
    model: { providerId: input.providerId, modelId: input.modelId },
    resolverRevision: "helarc-configured-instructions.v1",
    blocks,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
