import type { ControllerInput } from "@agent-anything/agent-runtime/controller";
import type { ContextProjection, ContextProjectionBlock } from "@agent-anything/context/projection";

const COMMAND_CHECK_DEFINITION_ID = "helarc-command-check";
const EXACT_TARGET_CHECK_DEFINITION_ID = "helarc-exact-target-state";
const COMMAND_TOOL_NAME = "PowerShell";

export function buildHelarcVerificationText(
  input: Pick<ControllerInput, "toolExposure" | "verification"> & {
    readonly context: ContextProjection | null;
  },
): string {
  const feedback = input.context === null ? null : readCurrentVerificationFeedback(input.context);
  const exposedToolNames = new Set(input.toolExposure.catalog.tools.map(({ name }) => name));
  return `Current verification:\n${JSON.stringify({
    runner: input.verification,
    feedback,
    operationalPaths: feedback === null
      ? []
      : readCheckPaths(feedback).flatMap<HelarcVerificationOperationalPath>((path) => {
          if (path.definition.id === COMMAND_CHECK_DEFINITION_ID) {
            return [{
              family: path.family,
              definition: path.definition,
              kind: "tool",
              toolName: COMMAND_TOOL_NAME,
              availability: exposedToolNames.has(COMMAND_TOOL_NAME) ? "available" : "not_exposed",
            }];
          }
          if (path.definition.id === EXACT_TARGET_CHECK_DEFINITION_ID) {
            return [{
              family: path.family,
              definition: path.definition,
              kind: "automatic",
              toolName: null,
              availability: "automatic",
            }];
          }
          return [];
        }),
  })}`;
}

export function isHelarcVerificationContextBlock(block: ContextProjectionBlock): boolean {
  return block.payload.kind === "structured" &&
    isRecord(block.payload.value) &&
    block.payload.value.kind === "verification_feedback";
}

function readCurrentVerificationFeedback(context: ContextProjection): Readonly<Record<string, unknown>> | null {
  for (let index = context.blocks.length - 1; index >= 0; index -= 1) {
    const block = context.blocks[index];
    if (block !== undefined && isHelarcVerificationContextBlock(block)) {
      return block.payload.kind === "structured" && isRecord(block.payload.value)
        ? block.payload.value
        : null;
    }
  }
  return null;
}

function readCheckPaths(feedback: Readonly<Record<string, unknown>>): readonly CheckPath[] {
  if (!Array.isArray(feedback.requirements)) return [];
  const paths = feedback.requirements.flatMap((requirement) => {
    if (!isRecord(requirement) || !Array.isArray(requirement.admittedChecks)) return [];
    return requirement.admittedChecks.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.family !== "string" || !isRecord(candidate.definition) ||
          typeof candidate.definition.id !== "string" || typeof candidate.definition.revision !== "string") {
        return [];
      }
      return [{
        family: candidate.family,
        definition: { id: candidate.definition.id, revision: candidate.definition.revision },
      }];
    });
  });
  return [...new Map(paths.map((path) => [
    `${path.definition.id}@${path.definition.revision}`,
    path,
  ])).values()];
}

interface CheckPath {
  readonly family: string;
  readonly definition: { readonly id: string; readonly revision: string };
}

interface HelarcVerificationOperationalPath {
  readonly family: string;
  readonly definition: { readonly id: string; readonly revision: string };
  readonly kind: "tool" | "automatic";
  readonly toolName: string | null;
  readonly availability: "available" | "not_exposed" | "automatic";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
