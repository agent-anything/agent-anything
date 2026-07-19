import type { ApprovalReviewRequest, ApprovalSubmissionReceipt } from "@agent-anything/permission";
import type { HelarcMainSnapshot as MainSnapshot } from "./HelarcMainController.js";
import type {
  HelarcAdditionalPermissionsSnapshot,
  HelarcApprovalReviewRequestSnapshot,
  HelarcApprovalSubmissionReceipt,
  HelarcMainSnapshot as DesktopSnapshot,
  HelarcProductPhaseSnapshot,
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
          activeConversationId: snapshot.activeThread.activeConversationId,
          messages: snapshot.activeThread.messages.map((message) => ({
            id: message.id,
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

export function projectHelarcApprovalSubmissionReceipt(
  receipt: ApprovalSubmissionReceipt,
): HelarcApprovalSubmissionReceipt {
  return receipt.status === "accepted_for_resolution"
    ? {
        status: receipt.status,
        submissionId: receipt.submissionId,
        runId: receipt.runId,
        requestId: receipt.requestId,
        pendingVersion: receipt.pendingVersion,
      }
    : {
        status: receipt.status,
        submissionId: receipt.submissionId,
        code: receipt.code,
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
    runId: run.runId,
    display: {
      status: run.display.status,
      terminal: run.display.terminal,
      statusSource: run.display.statusSource,
    },
    platform: {
      taskId: run.platform.taskId,
      startedAt: run.platform.startedAt,
      approval: run.platform.approval === null
        ? null
        : {
            phase: run.platform.approval.phase,
            review: run.platform.approval.review === null
              ? null
              : {
                  pendingVersion: run.platform.approval.review.pendingVersion,
                  request: projectApprovalRequest(run.platform.approval.review.request),
                },
          },
      terminal: run.platform.terminal === null
        ? null
        : {
            status: run.platform.terminal.status,
            code: run.platform.terminal.code,
            completedAt: run.platform.terminal.completedAt,
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
              workspaceId: run.product.result.output.workspaceId,
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
      runId: phase.runId,
      proposalId: phase.proposalId,
      reviewId: phase.reviewId,
      pendingVersion: phase.pendingVersion,
    };
  }
  return {
    kind: "waiting_for_patch_review",
    review: {
      runId: phase.review.runId,
      proposalId: phase.review.proposalId,
      reviewId: phase.review.reviewId,
      pendingVersion: phase.review.pendingVersion,
      phase: phase.review.phase,
      path: phase.review.path,
      operation: phase.review.operation,
      summary: phase.review.summary,
      originalContent: phase.review.originalContent,
      proposedContent: phase.review.proposedContent,
    },
  };
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
    case "mcpToolCall":
      return {
        ...base,
        category: request.category,
        payload: {
          serverDisplayName: request.payload.serverDisplayName,
          toolName: request.payload.toolName,
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
