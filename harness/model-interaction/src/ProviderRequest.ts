
import type { ProviderMessage } from "./ProviderMessage.js";
import type { ModelInputComposition } from "./input/index.js";

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly capability: string;
  readonly composition: ModelInputComposition;
  readonly metadata: Readonly<Record<string, unknown>>;
}
