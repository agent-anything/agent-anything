import type { AcceptedPatchStatus } from "../patch/PatchContracts.js";
import {
  CODE_AGENT_CREATE_FILE_ACTION,
  CODE_AGENT_DELETE_FILE_ACTION,
  CODE_AGENT_UPDATE_FILE_ACTION,
  type CodeAgentFileActionRequest,
} from "./FileActionContracts.js";

export function createAcceptedPatchFileAction(
  patch: AcceptedPatchStatus,
): CodeAgentFileActionRequest {
  if (patch.status !== "accepted" || patch.decision.status !== "accepted" ||
    patch.decision.runId !== patch.proposal.runId ||
    patch.decision.proposalId !== patch.proposal.id) {
    throw new TypeError("Only a consistently accepted patch can become a file Action.");
  }
  const operation = patch.proposal.operation;
  switch (operation.kind) {
    case "create":
      return Object.freeze({
        actionName: CODE_AGENT_CREATE_FILE_ACTION,
        input: Object.freeze({
          rootName: patch.proposal.rootName,
          path: operation.path,
          content: operation.proposedContent,
        }),
      });
    case "update":
      return Object.freeze({
        actionName: CODE_AGENT_UPDATE_FILE_ACTION,
        input: Object.freeze({
          rootName: patch.proposal.rootName,
          path: operation.path,
          expectedContentDigest: `sha256:${operation.originalContent.digest}`,
          content: operation.proposedContent,
        }),
      });
    case "delete":
      return Object.freeze({
        actionName: CODE_AGENT_DELETE_FILE_ACTION,
        input: Object.freeze({
          rootName: patch.proposal.rootName,
          path: operation.path,
          expectedContentDigest: `sha256:${operation.originalContent.digest}`,
        }),
      });
  }
}
