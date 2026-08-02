const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface RetryPolicy<TCategory extends string> {
  readonly maxRetries: number;
  readonly delay: RetryDelayPolicy;
  readonly retryableCategories: readonly TCategory[];
  readonly serverDelay: RetryServerDelayPolicy;
}

export type RetryServerDelayPolicy =
  | { readonly mode: "ignore" }
  | {
      readonly mode: "prefer_trusted";
      readonly maxServerDelayMs: number;
    };

export interface RetryDelayPolicy {
  readonly kind: "exponential_jitter";
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: 2;
  readonly jitterRatio: 0.1;
}

export function snapshotRetryPolicy<TCategory extends string>(
  policy: RetryPolicy<TCategory>,
  field = "RetryPolicy",
): RetryPolicy<TCategory> {
  if (!isRecord(policy)) {
    throw new TypeError(`${field} must be an object.`);
  }
  assertNonNegativeInteger(policy.maxRetries, `${field}.maxRetries`);
  if (policy.maxRetries >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${field}.maxRetries is too large.`);
  }
  if (!isRecord(policy.delay) || policy.delay.kind !== "exponential_jitter") {
    throw new TypeError(`${field}.delay must use exponential_jitter.`);
  }
  assertTimerDelay(policy.delay.baseDelayMs, `${field}.delay.baseDelayMs`);
  assertTimerDelay(policy.delay.maxDelayMs, `${field}.delay.maxDelayMs`);
  if (policy.delay.maxDelayMs < policy.delay.baseDelayMs) {
    throw new TypeError(`${field}.delay.maxDelayMs must not be less than baseDelayMs.`);
  }
  if (policy.delay.multiplier !== 2) {
    throw new TypeError(`${field}.delay.multiplier must be 2.`);
  }
  if (policy.delay.jitterRatio !== 0.1) {
    throw new TypeError(`${field}.delay.jitterRatio must be 0.1.`);
  }
  if (!Array.isArray(policy.retryableCategories)) {
    throw new TypeError(`${field}.retryableCategories must be an array.`);
  }
  const categories: TCategory[] = [];
  const seen = new Set<string>();
  for (const [index, category] of policy.retryableCategories.entries()) {
    assertNonEmpty(category, `${field}.retryableCategories[${index}]`);
    if (!seen.has(category)) {
      seen.add(category);
      categories.push(category as TCategory);
    }
  }

  let serverDelay: RetryServerDelayPolicy;
  if (!isRecord(policy.serverDelay)) {
    throw new TypeError(`${field}.serverDelay must be an object.`);
  }
  if (policy.serverDelay.mode === "ignore") {
    serverDelay = Object.freeze({ mode: "ignore" });
  } else if (policy.serverDelay.mode === "prefer_trusted") {
    assertTimerDelay(
      policy.serverDelay.maxServerDelayMs,
      `${field}.serverDelay.maxServerDelayMs`,
    );
    serverDelay = Object.freeze({
      mode: "prefer_trusted",
      maxServerDelayMs: policy.serverDelay.maxServerDelayMs,
    });
  } else {
    throw new TypeError(`${field}.serverDelay.mode is unsupported.`);
  }

  return Object.freeze({
    maxRetries: policy.maxRetries,
    delay: Object.freeze({
      kind: "exponential_jitter" as const,
      baseDelayMs: policy.delay.baseDelayMs,
      maxDelayMs: policy.delay.maxDelayMs,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    }),
    retryableCategories: Object.freeze(categories),
    serverDelay,
  });
}

function assertTimerDelay(value: number, field: string): void {
  assertNonNegativeInteger(value, field);
  if (value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${field} must not exceed ${MAX_TIMER_DELAY_MS}.`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
