

import type { ModelOpaqueContinuationState } from "./continuation/index.js";

export interface ProviderResponse<TOutput = unknown> {
  readonly responseId: string | null;
  readonly output: TOutput;
  readonly usage: ProviderUsage | null;
  readonly continuation: ModelOpaqueContinuationState | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ProviderFailure {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly statusCode?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}
