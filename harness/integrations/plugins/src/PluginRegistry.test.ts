import { describe, expect, it } from "vitest";
import type {
  PluginAdmissionInput,
  PluginContributionActivationPort,
  PluginManifestInput,
  PluginOwnerActivationRequest,
  PluginOwnerActivationResult,
  PluginOwnerDeactivationRequest,
  PluginOwnerDeactivationResult,
  PluginRecordSnapshot,
} from "./index.js";
import {
  PluginAdmissionValidationError,
  PluginRegistry,
  PluginRegistryError,
} from "./index.js";

describe("Plugin Registry manifest and installation", () => {
  it("validates Semantic Version compatibility and Host capabilities", () => {
    const registry = createRegistry();

    expect(registry.validate(createManifest())).toMatchObject({
      status: "valid",
      manifest: {
        id: "plugin.example",
        version: "1.0.0",
        compatibility: {
          requiredHostCapabilityIds: ["host.approval", "host.workspace"],
        },
      },
      issues: [],
    });
    expect(registry.validate(createManifest({
      compatibility: {
        harnessPluginApiRange: ">=2.0.0",
        requiredHostCapabilityIds: ["host.workspace"],
      },
    }))).toMatchObject({
      status: "invalid",
      issues: [{ code: "plugin_manifest_incompatible" }],
    });
    expect(registry.validate(createManifest({
      compatibility: {
        harnessPluginApiRange: "^1.0.0",
        requiredHostCapabilityIds: ["host.unavailable"],
      },
    }))).toMatchObject({
      status: "invalid",
      issues: [{ code: "plugin_host_capability_missing" }],
    });
    expect(registry.validate(createManifest({ version: "v1.0.0" })))
      .toMatchObject({
        status: "invalid",
        issues: [{ code: "plugin_manifest_version_invalid" }],
      });
  });

  it("installs a defensive immutable snapshot in disabled state", () => {
    const manifest = mutableManifest();
    const registry = createRegistry();

    const installed = registry.install(manifest);
    manifest.displayName = "Mutated";
    manifest.contributions[0]!.displayName = "Mutated Tool";
    manifest.contributions[0]!.declaration.command = "mutated";
    manifest.metadata.owner = "mutated";
    manifest.compatibility.requiredHostCapabilityIds.push("host.unavailable");

    const retained = registry.get("plugin.example");
    expect(retained).toEqual(installed);
    expect(retained).toMatchObject({
      enablement: "disabled",
      admission: null,
      activation: null,
      stateRevision: 1,
      manifest: {
        displayName: "Example Plugin",
        metadata: { owner: "example" },
      },
    });
    expect(
      retained!.manifest.contributions.find(
        (candidate) => candidate.kind === "tool",
      ),
    ).toMatchObject({
      displayName: "Lookup Tool",
      declaration: { command: "lookup" },
    });
    expect(
      retained!.manifest.contributions.find(
        (candidate) => candidate.kind === "mcpServer",
      ),
    ).toMatchObject({ displayName: "Network MCP" });
    expect(
      retained!.manifest.contributions.find(
        (candidate) => candidate.kind === "policy",
      ),
    ).toMatchObject({ displayName: "Managed Policy" });
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained!.manifest)).toBe(true);
    expect(Object.isFrozen(retained!.manifest.contributions)).toBe(true);
    expect(
      Object.isFrozen(retained!.manifest.contributions[0]!.declaration),
    ).toBe(true);
  });

  it("rejects accessors and same-version package identity changes", () => {
    const registry = createRegistry();
    const manifest = createManifest() as Record<string, unknown>;
    Object.defineProperty(manifest, "metadata", {
      enumerable: true,
      get() {
        return {};
      },
    });

    expect(registry.validate(manifest)).toMatchObject({
      status: "invalid",
      issues: [{ code: "plugin_manifest_invalid" }],
    });

    const installed = registry.install(createManifest());
    expect(() =>
      registry.update({
        ...mutationTarget(installed),
        manifest: createManifest({
          displayName: "Changed Same Version",
        }),
      })
    ).toThrowError(expect.objectContaining({
      code: "plugin_package_identity_conflict",
    }));
  });

  it("treats contribution identity as local to one Plugin manifest", () => {
    const registry = createRegistry();
    registry.install(createManifest());

    expect(() =>
      registry.install(createManifest({
        id: "plugin.second",
        displayName: "Second Plugin",
        version: "2.0.0",
      }))
    ).not.toThrow();
    expect(registry.list()).toHaveLength(2);
  });
});

describe("Plugin Registry admission", () => {
  it("keeps enablement, Host admission, and activation separate", () => {
    const registry = createRegistry();
    const installed = registry.install(createManifest());

    expect(() =>
      registry.recordAdmission({
        ...mutationTarget(installed),
        admission: createAdmission(installed),
      })
    ).toThrowError(expect.objectContaining({
      code: "plugin_state_invalid",
    }));

    const enabled = registry.enable(mutationTarget(installed));
    const admitted = registry.recordAdmission({
      ...mutationTarget(enabled),
      admission: createAdmission(enabled),
    });

    expect(admitted).toMatchObject({
      enablement: "enabled",
      admission: { outcome: "admitted" },
      activation: null,
    });
    expect(registry.getActive("plugin.example")).toBeNull();
  });

  it("requires Host-managed trust for every selected Policy contribution", () => {
    const registry = createRegistry();
    const installed = registry.install(createManifest());
    const enabled = registry.enable(mutationTarget(installed));
    const policy = contribution(enabled, "policy");
    const admission = createAdmission(enabled, [{
      kind: "policy",
      contributionId: policy.id,
      descriptorFingerprint: policy.descriptorFingerprint,
    } as never]);

    expect(() =>
      registry.recordAdmission({
        ...mutationTarget(enabled),
        admission,
      })
    ).toThrowError(PluginAdmissionValidationError);
    expect(() =>
      registry.recordAdmission({
        ...mutationTarget(enabled),
        admission,
      })
    ).toThrowError(expect.objectContaining({
      code: "plugin_policy_trust_required",
    }));
  });

  it("rejects stale mutation targets", () => {
    const registry = createRegistry();
    const installed = registry.install(createManifest());
    registry.enable(mutationTarget(installed));

    expect(() => registry.enable(mutationTarget(installed))).toThrowError(
      expect.objectContaining({ code: "plugin_state_stale" }),
    );
  });
});

describe("Plugin Registry owner activation", () => {
  it("fails closed when trusted Host composition is unavailable", async () => {
    const registry = createRegistry();
    const admitted = installAndAdmit(registry);

    await expect(registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    })).rejects.toMatchObject({
      code: "plugin_activation_unavailable",
    });
    expect(registry.get("plugin.example")).toMatchObject({
      stateRevision: admitted.stateRevision,
      activation: null,
    });
  });

  it("publishes exact owner receipts and Plugin activation provenance", async () => {
    const port = new FakeActivationPort();
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);

    const activation = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });

    expect(activation).toMatchObject({
      pluginId: "plugin.example",
      pluginVersion: "1.0.0",
      manifestFingerprint: admitted.manifest.manifestFingerprint,
      admissionFingerprint: admitted.admission!.admissionFingerprint,
      packageDigest: admitted.manifest.provenance.packageDigest,
      activationEpoch: 1,
      ownerCommitId: "owner-commit-1",
      receipts: [
        {
          kind: "mcpServer",
          contributionId: "network",
          source: {
            kind: "plugin",
            sourceId: "plugin.example",
            activationEpoch: 1,
          },
        },
        {
          kind: "policy",
          contributionId: "managed",
          managedTrustFingerprint: fingerprint("4"),
          composition: "restrictive",
        },
        {
          kind: "tool",
          contributionId: "lookup",
          enforcement: "sandbox-execution-gateway",
        },
      ],
    });
    expect(registry.resolveActivation({
      pluginId: "plugin.example",
      manifestFingerprint: admitted.manifest.manifestFingerprint,
      activationEpoch: 1,
    })).toBe(activation);
    const tool = contribution(admitted, "tool");
    expect(registry.resolveContributionActivation({
      pluginId: "plugin.example",
      manifestFingerprint: admitted.manifest.manifestFingerprint,
      activationEpoch: 1,
      kind: "tool",
      contributionId: tool.id,
      descriptorFingerprint: tool.descriptorFingerprint,
    })).toMatchObject({
      localToolName: "plugin.example.lookup",
      enforcement: "sandbox-execution-gateway",
    });
  });

  it("copies owner results before publishing trusted activation state", async () => {
    const port = new FakeActivationPort();
    let mutableResult: PluginOwnerActivationResult | null = null;
    port.activateHandler = async (request) => {
      mutableResult = successfulActivation(request);
      return mutableResult;
    };
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    const activation = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });

    const mutable = mutableResult as unknown as {
      receipts: Array<{ localToolName?: string }>;
    };
    const toolReceipt = mutable.receipts.find(
      (receipt) => receipt.localToolName !== undefined,
    )!;
    toolReceipt.localToolName = "mutated";
    mutable.receipts.splice(0);

    expect(activation.receipts).toHaveLength(3);
    expect(activation.receipts.find((receipt) => receipt.kind === "tool"))
      .toMatchObject({ localToolName: "plugin.example.lookup" });
  });

  it("rejects incomplete owner receipts without consuming an epoch", async () => {
    const port = new FakeActivationPort();
    port.activateHandler = async (request) => ({
      ...successfulActivation(request),
      receipts: successfulActivation(request).receipts.slice(1),
    } as PluginOwnerActivationResult);
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);

    await expect(registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    })).rejects.toMatchObject({
      code: "plugin_owner_result_invalid",
    });
    expect(registry.get("plugin.example")).toMatchObject({
      stateRevision: admitted.stateRevision,
      activation: null,
    });

    port.activateHandler = async (request) => successfulActivation(request);
    const activation = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    expect(activation.activationEpoch).toBe(1);
  });

  it("rejects a Tool receipt that bypasses gateway enforcement", async () => {
    const port = new FakeActivationPort();
    port.activateHandler = async (request) => {
      const result = successfulActivation(request);
      if (result.status !== "activated") return result;
      return {
        ...result,
        receipts: result.receipts.map((receipt) =>
          receipt.kind === "tool"
            ? { ...receipt, enforcement: "direct" }
            : receipt
        ),
      } as unknown as PluginOwnerActivationResult;
    };
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);

    await expect(registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    })).rejects.toMatchObject({
      code: "plugin_owner_result_invalid",
    });
    expect(registry.getActive("plugin.example")).toBeNull();
  });

  it("rejects Policy receipts outside the admitted managed trust", async () => {
    const port = new FakeActivationPort();
    port.activateHandler = async (request) => {
      const result = successfulActivation(request);
      if (result.status !== "activated") return result;
      return {
        ...result,
        receipts: result.receipts.map((receipt) =>
          receipt.kind === "policy"
            ? { ...receipt, managedTrustFingerprint: fingerprint("b") }
            : receipt
        ),
      };
    };
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);

    await expect(registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    })).rejects.toMatchObject({
      code: "plugin_owner_result_invalid",
    });
    expect(registry.getActive("plugin.example")).toBeNull();
  });

  it("rejects owner denial without consuming an epoch", async () => {
    const port = new FakeActivationPort();
    port.activateHandler = async (request) => ({
      status: "rejected",
      requestId: request.requestId,
      code: "owner_conflict",
      message: "Destination-owner registration conflicts.",
    });
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);

    await expect(registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    })).rejects.toMatchObject({
      code: "plugin_activation_rejected",
    });

    port.activateHandler = async (request) => successfulActivation(request);
    const activation = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    expect(activation.activationEpoch).toBe(1);
  });

  it("allocates a new epoch after complete deactivation and reactivation", async () => {
    const port = new FakeActivationPort();
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    const first = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    const active = registry.get("plugin.example")!;
    const inactive = await registry.deactivate({
      ...mutationTarget(active),
      expectedAdmissionFingerprint:
        active.admission!.admissionFingerprint,
      expectedActivationId: first.activationId,
      expectedActivationEpoch: first.activationEpoch,
    });

    const second = await registry.activate({
      ...mutationTarget(inactive),
      expectedAdmissionFingerprint:
        inactive.admission!.admissionFingerprint,
    });

    expect(second.activationEpoch).toBe(2);
    expect(second.activationId).not.toBe(first.activationId);
    expect(registry.resolveActivation({
      pluginId: first.pluginId,
      manifestFingerprint: first.manifestFingerprint,
      activationEpoch: first.activationEpoch,
    })).toBeNull();
  });

  it("blocks concurrent lifecycle mutation while owner activation is pending", async () => {
    const port = new FakeActivationPort();
    let settle!: (result: PluginOwnerActivationResult) => void;
    port.activateHandler = (request) =>
      new Promise((resolve) => {
        settle = resolve;
        port.pendingRequest = request;
      });
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    const activationPromise = registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });

    await Promise.resolve();
    await expect(registry.disable(mutationTarget(admitted))).rejects
      .toMatchObject({ code: "plugin_operation_in_progress" });
    settle(successfulActivation(port.pendingRequest!));
    await expect(activationPromise).resolves.toMatchObject({
      activationEpoch: 1,
    });
  });
});

describe("Plugin Registry invalidation and update", () => {
  it("retains honest active state when owner deactivation fails", async () => {
    const port = new FakeActivationPort();
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    const activation = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    const activeRecord = registry.get("plugin.example")!;
    port.deactivateHandler = async () => {
      throw new Error("owner unavailable");
    };

    await expect(registry.disable(mutationTarget(activeRecord))).rejects
      .toMatchObject({ code: "plugin_deactivation_failed" });
    expect(registry.get("plugin.example")).toMatchObject({
      enablement: "enabled",
      stateRevision: activeRecord.stateRevision,
      activation: { activationId: activation.activationId },
    });
  });

  it("deactivates owner registrations before disabling and stales resolution", async () => {
    const port = new FakeActivationPort();
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    const activation = await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    const activeRecord = registry.get("plugin.example")!;

    const disabled = await registry.disable(mutationTarget(activeRecord));

    expect(port.deactivationRequests).toHaveLength(1);
    expect(port.deactivationRequests[0]!.activation.activationId)
      .toBe(activation.activationId);
    expect(disabled).toMatchObject({
      enablement: "disabled",
      activation: null,
    });
    expect(registry.resolveActivation({
      pluginId: "plugin.example",
      manifestFingerprint: activation.manifestFingerprint,
      activationEpoch: activation.activationEpoch,
    })).toBeNull();
  });

  it("deactivates before admission revocation", async () => {
    const port = new FakeActivationPort();
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    const activeRecord = registry.get("plugin.example")!;

    const revoked = await registry.revokeAdmission({
      ...mutationTarget(activeRecord),
      expectedAdmissionFingerprint:
        activeRecord.admission!.admissionFingerprint,
      decisionId: "decision-revoke",
      authorityId: "host.security",
      reason: "Publisher trust was revoked.",
      decidedAt: NOW,
    });

    expect(port.deactivationRequests).toHaveLength(1);
    expect(revoked).toMatchObject({
      activation: null,
      admission: {
        outcome: "revoked",
        supersedesAdmissionFingerprint:
          activeRecord.admission!.admissionFingerprint,
      },
    });
  });

  it("requires inactive update, advances version, and invalidates admission", async () => {
    const port = new FakeActivationPort();
    const registry = createRegistry(port);
    const admitted = installAndAdmit(registry);
    await registry.activate({
      ...mutationTarget(admitted),
      expectedAdmissionFingerprint:
        admitted.admission!.admissionFingerprint,
    });
    const active = registry.get("plugin.example")!;

    expect(() =>
      registry.update({
        ...mutationTarget(active),
        manifest: createManifest({ version: "1.1.0" }),
      })
    ).toThrowError(expect.objectContaining({
      code: "plugin_state_invalid",
    }));

    const inactive = await registry.deactivate({
      ...mutationTarget(active),
      expectedAdmissionFingerprint:
        active.admission!.admissionFingerprint,
      expectedActivationId: active.activation!.activationId,
      expectedActivationEpoch: active.activation!.activationEpoch,
    });
    const updated = registry.update({
      ...mutationTarget(inactive),
      manifest: createManifest({ version: "1.1.0" }),
    });

    expect(updated).toMatchObject({
      enablement: "enabled",
      manifest: { version: "1.1.0" },
      admission: null,
      activation: null,
    });
  });
});

const NOW = "2026-08-03T00:00:00.000Z";

class FakeActivationPort implements PluginContributionActivationPort {
  readonly activationRequests: PluginOwnerActivationRequest[] = [];
  readonly deactivationRequests: PluginOwnerDeactivationRequest[] = [];
  pendingRequest: PluginOwnerActivationRequest | null = null;
  activateHandler = async (
    request: PluginOwnerActivationRequest,
  ): Promise<PluginOwnerActivationResult> => successfulActivation(request);
  deactivateHandler = async (
    request: PluginOwnerDeactivationRequest,
  ): Promise<PluginOwnerDeactivationResult> => ({
    status: "deactivated",
    requestId: request.requestId,
    activationId: request.activation.activationId,
    ownerCommitId: "owner-deactivation-commit",
    deactivatedAt: NOW,
  });

  async activate(
    request: PluginOwnerActivationRequest,
  ): Promise<PluginOwnerActivationResult> {
    this.activationRequests.push(request);
    return this.activateHandler(request);
  }

  async deactivate(
    request: PluginOwnerDeactivationRequest,
  ): Promise<PluginOwnerDeactivationResult> {
    this.deactivationRequests.push(request);
    return this.deactivateHandler(request);
  }
}

function createRegistry(
  activationPort?: PluginContributionActivationPort,
): PluginRegistry {
  let id = 0;
  return new PluginRegistry({
    environment: {
      harnessPluginApiVersion: "1.2.0",
      hostCapabilityIds: ["host.workspace", "host.approval"],
    },
    activationPort,
    now: () => new Date(NOW),
    createId: () => `plugin-id-${++id}`,
  });
}

function installAndAdmit(registry: PluginRegistry): PluginRecordSnapshot {
  const installed = registry.install(createManifest());
  const enabled = registry.enable(mutationTarget(installed));
  return registry.recordAdmission({
    ...mutationTarget(enabled),
    admission: createAdmission(enabled),
  });
}

function createAdmission(
  record: PluginRecordSnapshot,
  contributions = record.manifest.contributions.map((candidate) =>
    candidate.kind === "policy"
      ? {
        kind: candidate.kind,
        contributionId: candidate.id,
        descriptorFingerprint: candidate.descriptorFingerprint,
        managedTrust: {
          configurationId: "managed-policy",
          configurationRevision: "1",
          configurationFingerprint: fingerprint("4"),
        },
      }
      : {
        kind: candidate.kind,
        contributionId: candidate.id,
        descriptorFingerprint: candidate.descriptorFingerprint,
      }
  ),
): PluginAdmissionInput {
  return {
    decisionId: "decision-admit",
    authorityId: "host.security",
    manifestFingerprint: record.manifest.manifestFingerprint,
    outcome: "admitted",
    contributions,
    reason: null,
    supersedesAdmissionFingerprint: null,
    decidedAt: NOW,
  };
}

function createManifest(
  overrides: Partial<PluginManifestInput> = {},
): PluginManifestInput {
  return {
    id: "plugin.example",
    displayName: "Example Plugin",
    version: "1.0.0",
    provenance: {
      sourceKind: "registry",
      sourceId: "registry.example/plugin.example",
      packageDigest: fingerprint("1"),
      publisherId: "publisher.example",
    },
    compatibility: {
      harnessPluginApiRange: "^1.0.0",
      requiredHostCapabilityIds: ["host.workspace", "host.approval"],
    },
    contributions: [
      {
        kind: "tool",
        id: "lookup",
        displayName: "Lookup Tool",
        declaration: { command: "lookup" },
        metadata: {},
      },
      {
        kind: "mcpServer",
        id: "network",
        displayName: "Network MCP",
        declaration: { configurationRef: "mcp.network" },
        metadata: {},
      },
      {
        kind: "policy",
        id: "managed",
        displayName: "Managed Policy",
        declaration: { implementationRef: "policy.managed" },
        metadata: {},
      },
    ],
    metadata: { owner: "example" },
    ...overrides,
  };
}

function mutableManifest() {
  return createManifest() as {
    displayName: string;
    metadata: { owner: string };
    compatibility: { requiredHostCapabilityIds: string[] };
    contributions: Array<{
      displayName: string;
      declaration: { command?: string; configurationRef?: string; implementationRef?: string };
    }>;
  } & PluginManifestInput;
}

function mutationTarget(record: PluginRecordSnapshot) {
  return {
    pluginId: record.manifest.id,
    expectedManifestFingerprint: record.manifest.manifestFingerprint,
    expectedStateRevision: record.stateRevision,
  };
}

function contribution(
  record: PluginRecordSnapshot,
  kind: "tool" | "mcpServer" | "policy",
) {
  return record.manifest.contributions.find(
    (candidate) => candidate.kind === kind,
  )!;
}

function successfulActivation(
  request: PluginOwnerActivationRequest,
): PluginOwnerActivationResult {
  return {
    status: "activated",
    requestId: request.requestId,
    pluginId: request.pluginId,
    manifestFingerprint: request.manifestFingerprint,
    admissionFingerprint: request.admissionFingerprint,
    activationEpoch: request.proposedActivationEpoch,
    ownerCommitId: "owner-commit-1",
    receipts: request.contributions.map((candidate) => {
      switch (candidate.kind) {
        case "tool":
          return {
            kind: candidate.kind,
            contributionId: candidate.contributionId,
            descriptorFingerprint: candidate.descriptorFingerprint,
            source: candidate.source,
            localToolName:
              `${request.pluginId}.${candidate.contributionId}`,
            toolRegistrationFingerprint: fingerprint("5"),
            toolRegistrationSnapshotId: fingerprint("6"),
            actionRegistrationFingerprint: fingerprint("7"),
            actionRegistrationSnapshotId: fingerprint("8"),
            enforcement: "sandbox-execution-gateway",
          };
        case "mcpServer":
          return {
            kind: candidate.kind,
            contributionId: candidate.contributionId,
            descriptorFingerprint: candidate.descriptorFingerprint,
            source: candidate.source,
            serverId: `${request.pluginId}.${candidate.contributionId}`,
            mcpRegistrationFingerprint: fingerprint("9"),
          };
        case "policy":
          return {
            kind: candidate.kind,
            contributionId: candidate.contributionId,
            descriptorFingerprint: candidate.descriptorFingerprint,
            source: candidate.source,
            policyProviderId:
              `${request.pluginId}.${candidate.contributionId}`,
            policyRegistrationFingerprint: fingerprint("a"),
            managedTrustFingerprint:
              candidate.admission.kind === "policy"
                ? candidate.admission.managedTrust.configurationFingerprint
                : fingerprint("b"),
            composition: "restrictive",
          };
      }
    }),
    activatedAt: NOW,
  };
}

function fingerprint(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
