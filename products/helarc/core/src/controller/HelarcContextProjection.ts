import type { ContextProjection } from "@agent-anything/context/projection";
import type { RunObservation } from "@agent-anything/agent-runtime/run";

export function readHelarcRunObservations(
  projection: ContextProjection,
): readonly RunObservation[] {
  return Object.freeze(projection.blocks.flatMap((block) => {
    if (block.payload.kind !== "structured") return [];
    const value = block.payload.value;
    if (
      !isRecord(value) ||
      value.kind !== "run_observation" ||
      !isRecord(value.observation)
    ) return [];
    return [value.observation as unknown as RunObservation];
  }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
