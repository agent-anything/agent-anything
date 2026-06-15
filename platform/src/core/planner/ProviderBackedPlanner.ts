import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";
import type { Planner } from "./Planner.js";
import type { PlannerInput } from "./PlannerInput.js";
import type { PlanStep } from "./PlanStep.js";

export type BuildProviderRequest = (
  input: PlannerInput,
) => ProviderRequest | Promise<ProviderRequest>;

export type ParseProviderResponse = (
  response: ProviderResponse,
  input: PlannerInput,
) => PlanStep | Promise<PlanStep>;

export interface ProviderBackedPlannerInput {
  provider: Provider;
  buildRequest: BuildProviderRequest;
  parseResponse: ParseProviderResponse;
}

export class ProviderBackedPlanner implements Planner {
  constructor(
    private readonly input: ProviderBackedPlannerInput,
  ) {}

  async plan(plannerInput: PlannerInput): Promise<PlanStep> {
    const request = await this.input.buildRequest(plannerInput);
    const response = await this.sendRequest(request);

    if (response.status === "failed") {
      throw new Error(response.error?.message ?? "Provider failed.");
    }

    return this.input.parseResponse(response, plannerInput);
  }

  private async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      return await this.input.provider.send(request);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Provider request failed.",
      );
    }
  }
}
