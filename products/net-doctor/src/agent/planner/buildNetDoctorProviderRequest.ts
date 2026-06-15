import type { PlannerInput } from "@agent-anything/agent-core";
import type { ProviderRequest } from "@agent-anything/providers";
import {
  buildNetDoctorPlannerPrompt,
  netDoctorPlannerCapability,
} from "./netDoctorPlannerPrompt.js";

export function buildNetDoctorProviderRequest(
  input: PlannerInput,
): ProviderRequest {
  return {
    messages: [
      {
        role: "system",
        content: "You plan safe NetDoctor diagnostics and return structured JSON only.",
        metadata: {
          product: "net-doctor",
        },
      },
      {
        role: "user",
        content: buildNetDoctorPlannerPrompt(input),
        metadata: {
          taskId: input.task.id,
        },
      },
    ],
    capability: netDoctorPlannerCapability,
    metadata: {
      product: "net-doctor",
      taskId: input.task.id,
      taskKind: input.task.kind,
    },
  };
}
