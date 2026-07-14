import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import type {
  PersistentPolicyAmendmentCommit,
  PersistentPolicyAmendmentCommitResult,
  PersistentPolicyAmendmentPort,
} from "./PersistentPolicyAmendmentPort.js";
import { normalizePolicyAmendment } from "./normalizePolicyAmendment.js";

describe("policy amendments", () => {
  it("normalizes and freezes an exec-policy amendment", () => {
    const result = normalizePolicyAmendment({
      kind: "exec_policy",
      amendment: {
        amendmentId: "amendment.exec.1",
        environmentId: "local",
        commandPattern: ["pnpm", "test"],
        cwd: "/work/repo",
        effect: "allow",
        sourceFingerprint: "sha256:command",
      },
    });

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(Object.isFrozen(result.amendment)).toBe(true);
      expect(Object.isFrozen(result.amendment.amendment.commandPattern)).toBe(true);
    }
  });

  it("canonicalizes deterministic network amendment collections", () => {
    const result = normalizePolicyAmendment({
      kind: "network_policy",
      amendment: {
        amendmentId: "amendment.network.1",
        environmentId: "local",
        hostPattern: "*.example.com",
        ports: [443, 80, 443],
        protocols: ["https", "http", "https"],
        effect: "allow",
        sourceFingerprint: "sha256:network",
      },
    });

    expect(result).toMatchObject({
      status: "valid",
      amendment: {
        amendment: {
          ports: [80, 443],
          protocols: ["http", "https"],
        },
      },
    });
  });

  it("rejects malformed network targets", () => {
    const result = normalizePolicyAmendment({
      kind: "network_policy",
      amendment: {
        amendmentId: "amendment.network.1",
        environmentId: "local",
        hostPattern: "https://example.com",
        ports: [70_000],
        protocols: ["HTTPS"],
        effect: "allow",
        sourceFingerprint: "sha256:network",
      },
    });

    expect(result).toMatchObject({
      status: "invalid",
      code: "policy_amendment_invalid_network_target",
    });
  });

  it.each([".", "*.."])(
    "rejects a host pattern that becomes empty after canonicalization: %s",
    (hostPattern) => {
      const result = normalizePolicyAmendment({
        kind: "network_policy",
        amendment: {
          amendmentId: "amendment.network.1",
          environmentId: "local",
          hostPattern,
          ports: [443],
          protocols: ["https"],
          effect: "allow",
          sourceFingerprint: "sha256:network",
        },
      });

      expect(result).toMatchObject({
        status: "invalid",
        code: "policy_amendment_invalid_network_target",
      });
    },
  );

  it("keeps outcome certainty explicit on the persistent port", async () => {
    const port = new FakePersistentPolicyAmendmentPort({
      kind: "outcome_unknown",
      code: "policy_amendment_commit_outcome_unknown",
      message: "Storage acknowledgement was lost.",
    });
    const commit = createCommit();

    await expect(port.commit(commit, interruptionContext())).resolves.toEqual({
      kind: "outcome_unknown",
      code: "policy_amendment_commit_outcome_unknown",
      message: "Storage acknowledgement was lost.",
    });
    expect(port.commits).toEqual([commit]);
  });
});

class FakePersistentPolicyAmendmentPort
  implements PersistentPolicyAmendmentPort
{
  readonly commits: PersistentPolicyAmendmentCommit[] = [];

  constructor(private readonly result: PersistentPolicyAmendmentCommitResult) {}

  async commit(
    input: PersistentPolicyAmendmentCommit,
    _context: InvocationInterruptionContext,
  ): Promise<PersistentPolicyAmendmentCommitResult> {
    this.commits.push(input);
    return this.result;
  }
}

function createCommit(): PersistentPolicyAmendmentCommit {
  return {
    commitId: "commit_1",
    recordId: "record_1",
    proposalRef: "proposal_1",
    sourceRequestId: "request_1",
    sourceActionFingerprint: "sha256:command",
    amendment: {
      kind: "exec_policy",
      amendment: {
        amendmentId: "amendment.exec.1",
        environmentId: "local",
        commandPattern: ["pnpm", "test"],
        cwd: "/work/repo",
        effect: "allow",
        sourceFingerprint: "sha256:command",
      },
    },
    appliedAt: "2026-07-15T00:00:00.000Z",
  };
}

function interruptionContext(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
}
