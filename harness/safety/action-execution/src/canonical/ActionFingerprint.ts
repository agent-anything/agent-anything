import type { CanonicalActionSubject } from "./CanonicalActionSubject.js";
import { createCanonicalSha256Digest } from "./CanonicalEncoding.js";
import type { PreparedActionInvocation } from "./PreparedActionInvocation.js";

export const PREPARED_INVOCATION_FINGERPRINT_DOMAIN =
  "agent-anything.prepared-invocation.v1";
export const ACTION_FINGERPRINT_DOMAIN = "agent-anything.action.v1";

export function createPreparedInvocationDigest(
  invocation: PreparedActionInvocation,
): Promise<string> {
  return createCanonicalSha256Digest(PREPARED_INVOCATION_FINGERPRINT_DOMAIN, invocation);
}

export function createActionFingerprint(
  subject: CanonicalActionSubject,
): Promise<string> {
  return createCanonicalSha256Digest(ACTION_FINGERPRINT_DOMAIN, subject);
}
