

export interface ProviderResponse<TOutput = unknown> {
  readonly output: TOutput;
  readonly usage: ProviderUsage | null;
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
