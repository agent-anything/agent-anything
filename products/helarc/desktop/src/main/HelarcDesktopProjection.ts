import {
  APPROVAL_INTERACTION_PROTOCOL,
  type ApprovalReviewRequest,
} from "@agent-anything/permission";
import type {
  HostCommandReceipt,
  HostRunStatusQueryReceipt,
} from "@agent-anything/host/transport";
import { HELARC_PATCH_REVIEW_PROTOCOL } from "@agent-anything/helarc/composition";
import type { HelarcMainSnapshot as MainSnapshot } from "./HelarcMainController.js";
import type {
  HelarcAdditionalPermissionsSnapshot,
  HelarcApprovalReviewRequestSnapshot,
  HelarcHostCommandReceipt,
  HelarcInteractionRequestRefSnapshot,
  HelarcMainSnapshot as DesktopSnapshot,
  HelarcPendingInteractionSnapshot,
  HelarcPatchReviewPresentationSnapshot,
  HelarcProductPhaseSnapshot,
  HelarcRunStatusResponse,
  HelarcRunSnapshot,
} from "../shared/HelarcDesktopApi.js";

export function projectHelarcDesktopSnapshot(snapshot: MainSnapshot): DesktopSnapshot {
  return {
    status: snapshot.status,
    workspace: snapshot.workspace === null
      ? null
      : {
          id: snapshot.workspace.id,
          name: snapshot.workspace.name,
          path: snapshot.workspace.path,
        },
    workspaceProfiles: snapshot.workspaceProfiles.map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      path: profile.path,
      lastOpenedAt: profile.lastOpenedAt,
      trustState: profile.trustState,
    })),
    taskTemplates: snapshot.taskTemplates.map((template) => ({
      id: template.id,
      title: template.title,
      description: template.description,
      promptText: template.promptText,
      category: template.category,
      defaultConstraints: [...template.defaultConstraints],
    })),
    provider: projectProvider(snapshot.provider),
    acceptedTask: snapshot.acceptedTask === null
      ? null
      : {
          id: snapshot.acceptedTask.id,
          prompt: snapshot.acceptedTask.prompt,
        },
    activeThread: snapshot.activeThread === null
      ? null
      : {
          id: snapshot.activeThread.id,
          title: snapshot.activeThread.title,
          status: snapshot.activeThread.status,
          workspace: {
            id: snapshot.activeThread.workspace.id,
            name: snapshot.activeThread.workspace.name,
            path: snapshot.activeThread.workspace.path,
          },
          revision: snapshot.activeThread.revision,
          messages: snapshot.activeThread.messages.map((message) => ({
            id: message.id,
            sequence: message.sequence,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            relatedRunIds: [...message.relatedRunIds],
            relatedArtifactIds: [...message.relatedArtifactIds],
          })),
          artifacts: snapshot.activeThread.artifacts.map((artifact) => ({
            id: artifact.id,
            kind: artifact.kind,
            title: artifact.title,
            summary: artifact.summary,
            createdAt: artifact.createdAt,
            runId: artifact.runId,
          })),
        },
    threadSummaries: snapshot.threadSummaries.map((thread) => ({
      id: thread.id,
      title: thread.title,
      status: thread.status,
      workspace: {
        id: thread.workspace.id,
        name: thread.workspace.name,
        path: thread.workspace.path,
      },
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      latestRun: thread.latestRun === null
        ? null
        : {
            runId: thread.latestRun.runId,
            status: thread.latestRun.status,
            startedAt: thread.latestRun.startedAt,
            completedAt: thread.latestRun.completedAt,
          },
    })),
    run: snapshot.run === null ? null : projectRun(snapshot.run),
    error: snapshot.error === null
      ? null
      : { code: snapshot.error.code, message: snapshot.error.message },
  };
}

export function projectHelarcHostCommandReceipt(
  receipt: HostCommandReceipt,
): HelarcHostCommandReceipt {
  if (receipt.status === "rejected") {
    return {
      version: receipt.version,
      commandId: receipt.commandId,
      runId: receipt.runId,
      kind: receipt.kind,
      status: receipt.status,
      code: receipt.code,
    };
  }

  if (receipt.kind === "interaction.submit") {
    if (receipt.result.status === "rejected") {
      return {
        version: receipt.version,
        commandId: receipt.commandId,
        runId: receipt.runId,
        kind: receipt.kind,
        status: receipt.status,
        result: {
          status: receipt.result.status,
          code: receipt.result.code,
          receipt: receipt.result.receipt === null
            ? null
            : projectInteractionTransportReceipt(receipt.result.receipt),
        },
      };
    }
    return {
      version: receipt.version,
      commandId: receipt.commandId,
      runId: receipt.runId,
      kind: receipt.kind,
      status: receipt.status,
      result: {
        status: receipt.result.status,
        receipt: projectInteractionTransportReceipt(receipt.result.receipt),
      },
    };
  }

  if (receipt.kind === "run.steer") {
    if (receipt.result.status === "rejected") {
      return {
        version: receipt.version,
        commandId: receipt.commandId,
        runId: receipt.runId,
        kind: receipt.kind,
        status: receipt.status,
        result: {
          status: receipt.result.status,
          code: receipt.result.code,
          commandId: receipt.result.commandId,
          currentRunRevision: receipt.result.currentRunRevision,
        },
      };
    }
    return {
      version: receipt.version,
      commandId: receipt.commandId,
      runId: receipt.runId,
      kind: receipt.kind,
      status: receipt.status,
      result: {
        status: receipt.result.status,
        command: {
          commandId: receipt.result.command.commandId,
          expectedRunRevision: receipt.result.command.expectedRunRevision,
          acceptedRunRevision: receipt.result.command.acceptedRunRevision,
          instruction: receipt.result.command.instruction,
          submittedAt: receipt.result.command.submittedAt,
        },
      },
    };
  }

  if (
    receipt.result.status === "accepted" ||
    receipt.result.status === "already_requested"
  ) {
    return {
      version: receipt.version,
      commandId: receipt.commandId,
      runId: receipt.runId,
      kind: receipt.kind,
      status: receipt.status,
      result: {
        status: receipt.result.status,
        cancellation: {
          requestId: receipt.result.cancellation.requestId,
          origin: receipt.result.cancellation.origin,
          reasonCode: receipt.result.cancellation.reasonCode,
          requestedAt: receipt.result.cancellation.requestedAt,
        },
      },
    };
  }

  return {
    version: receipt.version,
    commandId: receipt.commandId,
    runId: receipt.runId,
    kind: receipt.kind,
    status: receipt.status,
    result: {
      status: receipt.result.status,
      cancellation: receipt.result.cancellation === null
        ? null
        : {
            requestId: receipt.result.cancellation.requestId,
            origin: receipt.result.cancellation.origin,
            reasonCode: receipt.result.cancellation.reasonCode,
            requestedAt: receipt.result.cancellation.requestedAt,
          },
    },
  };
}

export function projectHelarcRunStatusQueryReceipt(
  receipt: HostRunStatusQueryReceipt,
): HelarcRunStatusResponse["receipt"] {
  if (receipt.status === "rejected") {
    return {
      version: receipt.version,
      queryId: receipt.queryId,
      runId: receipt.runId,
      kind: receipt.kind,
      status: receipt.status,
      code: receipt.code,
    };
  }
  return {
    version: receipt.version,
    queryId: receipt.queryId,
    runId: receipt.runId,
    kind: receipt.kind,
    status: receipt.status,
    run: {
      runId: receipt.projection.runId,
      taskId: receipt.projection.taskId,
      runRevision: receipt.projection.runRevision,
      status: receipt.projection.status,
      startedAt: receipt.projection.startedAt,
      pendingInteractions: receipt.projection.pendingInteractions.map(projectPendingInteraction),
      terminal: receipt.projection.terminal === null
        ? null
        : {
            status: receipt.projection.terminal.status,
            code: receipt.projection.terminal.code,
            completedAt: receipt.projection.terminal.completedAt,
          },
    },
  };
}

function projectProvider(snapshot: MainSnapshot["provider"]): DesktopSnapshot["provider"] {
  if (!snapshot.configured) {
    return {
      configured: false,
      activeProfile: null,
      profiles: snapshot.profiles.map(projectProviderProfile),
      error: {
        code: snapshot.error.code,
        message: snapshot.error.message,
      },
    };
  }
  return {
    configured: true,
    activeProfile: projectProviderProfile(snapshot.activeProfile),
    profiles: snapshot.profiles.map(projectProviderProfile),
    error: null,
  };
}

function projectProviderProfile(
  profile: MainSnapshot["provider"]["profiles"][number],
): DesktopSnapshot["provider"]["profiles"][number] {
  return {
    id: profile.id,
    providerKind: profile.providerKind,
    displayName: profile.displayName,
    endpointLabel: profile.endpointLabel,
    baseUrl: profile.baseUrl,
    baseUrlOrigin: profile.baseUrlOrigin,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    credentialStatus: profile.credentialStatus,
    isActive: profile.isActive,
  };
}

function projectRun(run: NonNullable<MainSnapshot["run"]>): HelarcRunSnapshot {
  return {
    productRunId: run.productRunId,
    harnessRunId: run.harnessRunId,
    display: {
      status: run.display.status,
      terminal: run.display.terminal,
      statusSource: run.display.statusSource,
    },
    host: {
      taskId: run.host.taskId,
      startedAt: run.host.startedAt,
      runRevision: run.host.runRevision,
      pendingInteractions: run.host.pendingInteractions.map(projectPendingInteraction),
      terminal: run.host.terminal === null
        ? null
        : {
            status: run.host.terminal.status,
            code: run.host.terminal.code,
            completedAt: run.host.terminal.completedAt,
          },
    },
    product: {
      phase: projectProductPhase(run.product.phase),
      activity: run.product.activity.map((activity) => ({
        id: activity.id,
        sequence: activity.sequence,
        timestamp: activity.timestamp,
        kind: activity.kind,
        title: activity.title,
        detail: activity.detail,
        metadata: projectActivityMetadata(activity.metadata),
      })),
      result: run.product.result === null
        ? null
        : {
            status: run.product.result.status,
            output: {
              taskId: run.product.result.output.taskId,
              workspace: {
                primaryId: run.product.result.output.workspace.primaryId,
                additionalIds: [...run.product.result.output.workspace.additionalIds],
              },
              agentSummary: run.product.result.output.agentSummary,
              runtimeStatus: run.product.result.output.runtimeStatus,
              patchStatus: run.product.result.output.patchStatus,
              appliedPath: run.product.result.output.appliedPath,
              enforcement: {
                selected: run.product.result.output.enforcement.selected,
                status: run.product.result.output.enforcement.status,
                code: run.product.result.output.enforcement.code,
              },
              safeErrors: run.product.result.output.safeErrors.map((error) => ({
                code: error.code,
                message: error.message,
              })),
            },
          },
    },
  };
}

function projectActivityMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  const stringKeys = [
    "status",
    "controllerAction",
    "requestedToolName",
    "patchOperation",
    "patchPath",
    "promptArchitectureVersion",
    "actionContractVersion",
    "toolCatalogVersion",
  ] as const;

  for (const key of stringKeys) {
    if (typeof metadata[key] === "string") {
      projected[key] = metadata[key];
    }
  }

  if (
    Array.isArray(metadata.exposedToolNames)
    && metadata.exposedToolNames.every((item) => typeof item === "string")
  ) {
    projected.exposedToolNames = [...metadata.exposedToolNames];
  }

  return projected;
}

function projectProductPhase(
  phase: NonNullable<MainSnapshot["run"]>["product"]["phase"],
): HelarcProductPhaseSnapshot {
  if (phase.kind === "none") return { kind: "none" };
  if (phase.kind === "patch_action_submitted") {
    return {
      kind: phase.kind,
      proposalId: phase.proposalId,
      proposalRevision: phase.proposalRevision,
      reviewId: phase.reviewId,
      requestVersion: phase.requestVersion,
    };
  }
  return {
    kind: "patch_review_requested",
    proposalId: phase.proposalId,
    proposalRevision: phase.proposalRevision,
    reviewId: phase.reviewId,
  };
}

function projectPendingInteraction(
  pending: NonNullable<MainSnapshot["run"]>["host"]["pendingInteractions"][number],
): HelarcPendingInteractionSnapshot {
  const base = {
    request: projectInteractionRequestRef(pending.request),
    phase: pending.phase,
    disclosureClass: pending.disclosureClass,
    expiresAt: pending.expiresAt,
    blockingScope: pending.blockingScope,
  };
  if (sameProtocol(pending.request.protocol, APPROVAL_INTERACTION_PROTOCOL)) {
    try {
      return {
        ...base,
        family: "approval",
        presentation: projectApprovalRequest(
          requireApprovalReviewRequest(pending.presentation),
        ),
      };
    } catch {
      return { ...base, family: "unsupported", presentation: null };
    }
  }
  if (sameProtocol(pending.request.protocol, HELARC_PATCH_REVIEW_PROTOCOL)) {
    const presentation = projectPatchReviewPresentation(pending.presentation);
    return presentation === null
      ? { ...base, family: "unsupported", presentation: null }
      : { ...base, family: "patch_review", presentation };
  }
  return { ...base, family: "unsupported", presentation: null };
}

function projectInteractionTransportReceipt(receipt: {
  readonly receiptId: string;
  readonly request: Parameters<typeof projectInteractionRequestRef>[0];
  readonly submissionId: string;
  readonly status: "accepted_for_resolution" | "duplicate_identical" | "rejected";
  readonly recordedAt: string;
}) {
  return {
    receiptId: receipt.receiptId,
    request: projectInteractionRequestRef(receipt.request),
    submissionId: receipt.submissionId,
    status: receipt.status,
    recordedAt: receipt.recordedAt,
  };
}

function projectInteractionRequestRef(
  request: {
    readonly id: string;
    readonly protocol: { readonly owner: string; readonly kind: string; readonly revision: string };
    readonly requestVersion: number;
    readonly subject: { readonly owner: string; readonly kind: string; readonly id: string; readonly revision: string };
  },
): HelarcInteractionRequestRefSnapshot {
  return {
    id: request.id,
    protocol: { ...request.protocol },
    requestVersion: request.requestVersion,
    subject: { ...request.subject },
  };
}

function projectPatchReviewPresentation(
  value: unknown,
): HelarcPatchReviewPresentationSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentity(value.runId) || !isIdentity(value.proposalId) ||
    !Number.isSafeInteger(value.proposalRevision) || (value.proposalRevision as number) < 1 ||
    !isIdentity(value.reviewId) || typeof value.rootName !== "string" ||
    !isIdentity(value.workspaceId) || typeof value.path !== "string" ||
    (value.operation !== "create" && value.operation !== "update" && value.operation !== "delete") ||
    typeof value.summary !== "string" || typeof value.rationale !== "string" ||
    !isNullableString(value.originalContent) || !isNullableString(value.proposedContent) ||
    !isNullableNonNegativeInteger(value.originalContentBytes) ||
    !isNullableNonNegativeInteger(value.proposedContentBytes)
  ) return null;
  return {
    runId: value.runId,
    proposalId: value.proposalId,
    proposalRevision: value.proposalRevision as number,
    reviewId: value.reviewId,
    rootName: value.rootName,
    workspaceId: value.workspaceId,
    path: value.path,
    operation: value.operation,
    summary: value.summary,
    rationale: value.rationale,
    originalContent: value.originalContent,
    proposedContent: value.proposedContent,
    originalContentBytes: value.originalContentBytes as number | null,
    proposedContentBytes: value.proposedContentBytes as number | null,
  };
}

function requireApprovalReviewRequest(value: unknown): ApprovalReviewRequest {
  if (!isRecord(value) || ![
    "commandExecution",
    "fileChange",
    "permissions",
    "remoteToolCall",
    "skill",
    "networkAccess",
  ].includes(String(value.category))) {
    throw new TypeError("Approval presentation is invalid.");
  }
  return value as unknown as ApprovalReviewRequest;
}

function sameProtocol(
  left: { readonly owner: string; readonly kind: string; readonly revision: string },
  right: { readonly owner: string; readonly kind: string; readonly revision: string },
): boolean {
  return left.owner === right.owner && left.kind === right.kind && left.revision === right.revision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value) && (value as number) >= 0;
}

function projectApprovalRequest(
  request: ApprovalReviewRequest,
): HelarcApprovalReviewRequestSnapshot {
  const decisionOptions = request.decisionOptions.map((option) => ({
    id: option.id,
    kind: option.kind,
    label: option.label,
    description: option.description,
  }));
  const base = {
    id: request.id,
    runId: request.runId,
    reason: request.reason,
    decisionOptions,
  };

  switch (request.category) {
    case "commandExecution":
      return {
        ...base,
        category: request.category,
        payload: {
          commandDisplay: request.payload.commandDisplay,
          additionalPermissions: projectAdditionalPermissions(
            request.payload.additionalPermissions,
          ),
        },
      };
    case "fileChange":
      return {
        ...base,
        category: request.category,
        payload: {
          changes: request.payload.changes.map((change) => ({
            operation: change.operation,
            displayPath: change.displayPath,
          })),
          additionalPermissions: projectAdditionalPermissions(
            request.payload.additionalPermissions,
          ),
        },
      };
    case "permissions":
      return {
        ...base,
        category: request.category,
        payload: {
          permissions: projectAdditionalPermissions(request.payload.permissions) ?? {},
        },
      };
    case "remoteToolCall":
      return {
        ...base,
        category: request.category,
        payload: {
          sourceKind: request.payload.source.kind,
          sourceDisplayName: request.payload.source.displayName,
          serverDisplayName: request.payload.server.displayName,
          toolDisplayName: request.payload.tool.displayName,
        },
      };
    case "skill":
      return {
        ...base,
        category: request.category,
        payload: {
          skillDisplayName: request.payload.skillDisplayName,
          action: request.payload.action,
          requiredPermissions: projectAdditionalPermissions(
            request.payload.requiredPermissions,
          ),
        },
      };
    case "networkAccess":
      return {
        ...base,
        category: request.category,
        payload: { actionSummary: request.payload.actionSummary },
      };
  }
}

function projectAdditionalPermissions(
  permissions: HelarcAdditionalPermissionsSnapshot | null,
): HelarcAdditionalPermissionsSnapshot | null {
  if (permissions === null) return null;
  return {
    ...(permissions.fileSystem === undefined
      ? {}
      : {
          fileSystem: {
            ...(permissions.fileSystem.read === undefined
              ? {}
              : { read: [...permissions.fileSystem.read] }),
            ...(permissions.fileSystem.write === undefined
              ? {}
              : { write: [...permissions.fileSystem.write] }),
          },
        }),
    ...(permissions.network === undefined
      ? {}
      : {
          network: {
            enabled: permissions.network.enabled,
            ...(permissions.network.domains === undefined
              ? {}
              : { domains: [...permissions.network.domains] }),
          },
        }),
  };
}
