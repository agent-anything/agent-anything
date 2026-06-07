import type { Metadata } from "../shared/types.js";

export type ProviderResponseStatus = "succeeded" | "failed";

export interface ProviderResponse<TOutput = unknown> {
  status: ProviderResponseStatus;
  output: TOutput | null;
  usage: ProviderUsage | null;
  error: ProviderError | null;
  metadata: Metadata;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  metadata: Metadata;
}

export interface ProviderError {
  code: string;
  message: string;
  metadata?: Metadata;
}
