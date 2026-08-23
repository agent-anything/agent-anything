
import type { ProviderMessage } from "./ProviderMessage.js";
import type { ModelInputComposition, ModelOutputFormat } from "./input/index.js";
import type { ModelContinuationRef } from "./continuation/index.js";

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly capability: string;
  readonly composition: ModelInputComposition;
  readonly outputFormat: ModelOutputFormat;
  readonly continuation: ModelContinuationRef | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}
