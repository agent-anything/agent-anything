import type {
  ApprovalReviewContext,
  ApprovalReviewPayloadByCategory,
  ApprovalReviewRequest,
  ApprovalRequest,
} from "./ApprovalContracts.js";
import { cloneApprovalMetadata, deepFreezeApproval } from "./snapshot.js";

export function projectApprovalReviewRequest(
  request: ApprovalRequest,
): ApprovalReviewRequest {
  const base = {
    id: request.id,
    runId: request.runId,
    actionId: request.actionId,
    actionFingerprint: request.actionFingerprint,
    category: request.category,
    reason: request.reason,
    subject: {
      runId: request.subject.runId,
      actionId: request.subject.actionId,
      actionFingerprint: request.subject.actionFingerprint,
      environmentId: request.subject.environmentId,
      applicabilityKeyCount: request.subject.applicabilityKeys.length,
    },
    decisionOptions: mapNonEmpty(request.decisionOptions, (option) => ({
      id: option.id,
      kind: option.kind,
      scope: option.scope,
      label: option.label,
      description: option.description,
    })),
    createdAt: request.createdAt,
    deadlineAt: request.deadlineAt,
  };

  return deepFreezeApproval({
    ...base,
    payload: projectPayload(request),
  } as ApprovalReviewRequest);
}

export function snapshotApprovalReviewContext(
  context: ApprovalReviewContext,
): ApprovalReviewContext {
  return deepFreezeApproval({
    workspaceTrustState: context.workspaceTrustState,
    ruleOutcome: context.ruleOutcome,
    currentAuthority: { ...context.currentAuthority },
    annotations: cloneApprovalMetadata(context.annotations),
  });
}

function projectPayload(
  request: ApprovalRequest,
): ApprovalReviewPayloadByCategory[keyof ApprovalReviewPayloadByCategory] {
  switch (request.category) {
    case "commandExecution":
      return {
        commandDisplay: request.payload.safeCommandDisplay,
        cwdDisplay: request.payload.cwdDisplay,
        commandActions: request.payload.commandActions.map((action) => ({ ...action })),
        additionalPermissions: clonePermissions(request.payload.additionalPermissions),
      };
    case "fileChange":
      return {
        changes: request.payload.changes.map((change) => ({
          operation: change.operation,
          displayPath: change.displayPath,
          destinationDisplayPath: change.destinationDisplayPath,
        })),
        baselineFingerprint: request.payload.baselineFingerprint,
        additionalPermissions: clonePermissions(request.payload.additionalPermissions),
      };
    case "permissions":
      return {
        permissions: clonePermissions(request.payload.permissions)!,
        cwdDisplay: request.payload.cwdDisplay,
        environmentId: request.payload.environmentId,
      };
    case "mcpToolCall":
      return {
        serverId: request.payload.serverId,
        serverDisplayName: request.payload.serverDisplayName,
        toolName: request.payload.toolName,
        safeArguments: cloneApprovalMetadata(request.payload.safeArguments),
        annotations: { ...request.payload.annotations },
        supportsSessionAuthority: request.payload.supportsSessionAuthority,
      };
    case "skill":
      return {
        skillId: request.payload.skillId,
        skillDisplayName: request.payload.skillDisplayName,
        action: request.payload.action,
        requiredPermissions: clonePermissions(request.payload.requiredPermissions),
      };
    case "networkAccess":
      return { ...request.payload };
  }
}

function clonePermissions<T extends object>(permissions: T | null): T | null {
  if (permissions === null) return null;
  return {
    ...(permissions as T),
    ...(Reflect.has(permissions, "fileSystem")
      ? {
          fileSystem: {
            ...((permissions as { fileSystem?: object }).fileSystem ?? {}),
            ...((permissions as { fileSystem?: { read?: readonly string[] } }).fileSystem?.read
              ? { read: [...(permissions as { fileSystem: { read: readonly string[] } }).fileSystem.read] }
              : {}),
            ...((permissions as { fileSystem?: { write?: readonly string[] } }).fileSystem?.write
              ? { write: [...(permissions as { fileSystem: { write: readonly string[] } }).fileSystem.write] }
              : {}),
          },
        }
      : {}),
    ...(Reflect.has(permissions, "network")
      ? {
          network: {
            ...((permissions as { network?: object }).network ?? {}),
            ...((permissions as { network?: { domains?: readonly string[] } }).network?.domains
              ? { domains: [...(permissions as { network: { domains: readonly string[] } }).network.domains] }
              : {}),
          },
        }
      : {}),
  } as T;
}

function mapNonEmpty<TInput, TOutput>(
  values: readonly [TInput, ...TInput[]],
  mapper: (value: TInput) => TOutput,
): readonly [TOutput, ...TOutput[]] {
  const [first, ...rest] = values;
  return [mapper(first), ...rest.map(mapper)];
}
