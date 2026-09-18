import { MessageSquareText, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useState, type FormEvent } from "react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";

type ActiveRunProjection = NonNullable<HelarcMainSnapshot["run"]>;
type PendingInteractionView =
  ActiveRunProjection["host"]["pendingInteractions"][number];
type PendingApprovalView = Extract<
  PendingInteractionView,
  { family: "approval" }
>;
type PendingClarificationView = Extract<
  PendingInteractionView,
  { family: "clarification" }
>;

export function ApprovalPromptPanel({
  approval,
  submissionError,
  isBusy,
  onSubmit,
}: {
  approval: PendingApprovalView | null;
  submissionError: string | null;
  isBusy: boolean;
  onSubmit: (
    option: PendingApprovalView["presentation"]["decisionOptions"][number],
  ) => void;
}) {
  if (!approval) {
    return null;
  }
  const request = approval.presentation;
  const submitted = approval.phase === "submitted_for_resolution";

  return (
    <div className="permission-panel">
      <ShieldCheck size={24} aria-hidden="true" />
      <strong>{approvalCategoryLabel(request)}</strong>
      <span>{request.reason}</span>
      <code>{approvalRequestSummary(request)}</code>
      <div className="permission-meta">
        <span>{request.category}</span>
        <span>
          {approval.phase === "pending"
            ? "Awaiting review"
            : "Submitted for resolution"}
        </span>
      </div>
      {submissionError ? (
        <span className="error-text">{submissionError}</span>
      ) : null}
      <div className="permission-actions">
        {request.decisionOptions.map((option) => (
          <button
            className={approvalOptionButtonClass(option.kind)}
            key={option.id}
            type="button"
            title={option.description ?? undefined}
            onClick={() => onSubmit(option)}
            disabled={isBusy || submitted}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ClarificationPromptPanel({
  clarification,
  submissionError,
  isBusy,
  onSubmit,
}: {
  clarification: PendingClarificationView;
  submissionError: string | null;
  isBusy: boolean;
  onSubmit: (
    answers: readonly {
      readonly question_id: string;
      readonly selected_labels: readonly string[];
      readonly text: string | null;
    }[],
  ) => void;
}) {
  const [answers, setAnswers] = useState<
    Record<string, { selected: string[]; text: string }>
  >({});
  const submitted = clarification.phase === "submitted_for_resolution";
  const complete = clarification.presentation.questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(
      answer && (answer.selected.length > 0 || answer.text.trim().length > 0),
    );
  });

  function toggleLabel(
    questionId: string,
    label: string,
    allowMultiple: boolean,
  ) {
    setAnswers((current) => {
      const existing = current[questionId] ?? { selected: [], text: "" };
      const selected = existing.selected.includes(label)
        ? existing.selected.filter((item) => item !== label)
        : allowMultiple
          ? [...existing.selected, label]
          : [label];
      return { ...current, [questionId]: { ...existing, selected } };
    });
  }

  function setText(questionId: string, text: string) {
    setAnswers((current) => ({
      ...current,
      [questionId]: {
        selected: current[questionId]?.selected ?? [],
        text,
      },
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || submitted || isBusy) return;
    onSubmit(
      clarification.presentation.questions.map((question) => {
        const answer = answers[question.id]!;
        const text = answer.text.trim();
        return {
          question_id: question.id,
          selected_labels: answer.selected,
          text: text.length === 0 ? null : text,
        };
      }),
    );
  }

  return (
    <form className="clarification-panel" onSubmit={submit}>
      <MessageSquareText size={24} aria-hidden="true" />
      <strong>Helarc needs your input</strong>
      {clarification.presentation.questions.map((question) => {
        const answer = answers[question.id] ?? { selected: [], text: "" };
        return (
          <fieldset
            className="clarification-question"
            key={question.id}
            disabled={isBusy || submitted}
          >
            <legend>{question.prompt}</legend>
            {question.options.map((option) => (
              <label
                className="clarification-option"
                key={option.label}
                title={option.description}
              >
                <input
                  type={question.allowMultiple ? "checkbox" : "radio"}
                  name={`clarification-${question.id}`}
                  checked={answer.selected.includes(option.label)}
                  onChange={() =>
                    toggleLabel(
                      question.id,
                      option.label,
                      question.allowMultiple,
                    )
                  }
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            <textarea
              aria-label={`Free-text answer for ${question.prompt}`}
              placeholder="Type an answer"
              value={answer.text}
              onChange={(event) => setText(question.id, event.target.value)}
              rows={3}
            />
          </fieldset>
        );
      })}
      {submissionError ? (
        <span className="error-text">{submissionError}</span>
      ) : null}
      <div className="permission-actions">
        <button
          className="primary-button compact"
          type="submit"
          disabled={!complete || isBusy || submitted}
        >
          {submitted ? "Submitted" : "Submit"}
        </button>
      </div>
    </form>
  );
}

function approvalCategoryLabel(
  request: PendingApprovalView["presentation"],
): string {
  switch (request.category) {
    case "commandExecution":
      return "Command execution";
    case "fileChange":
      return "File change";
    case "permissions":
      return "Additional permissions";
    case "remoteToolCall":
      return request.payload.sourceKind === "mcp"
        ? "MCP tool call"
        : "Remote tool call";
    case "skill":
      return "Skill action";
    case "networkAccess":
      return "Network access";
  }
}

function approvalRequestSummary(
  request: PendingApprovalView["presentation"],
): string {
  switch (request.category) {
    case "commandExecution":
      return request.payload.commandDisplay;
    case "fileChange":
      return request.payload.changes
        .map((change) => `${change.operation} ${change.displayPath}`)
        .join(", ");
    case "permissions": {
      const readCount =
        request.payload.permissions.fileSystem?.read?.length ?? 0;
      const writeCount =
        request.payload.permissions.fileSystem?.write?.length ?? 0;
      const network =
        request.payload.permissions.network?.enabled === true
          ? "network"
          : null;
      return (
        [
          readCount > 0 ? `${readCount} read target(s)` : null,
          writeCount > 0 ? `${writeCount} write target(s)` : null,
          network,
        ]
          .filter((value): value is string => value !== null)
          .join(", ") || "Permission expansion"
      );
    }
    case "remoteToolCall":
      return `${request.payload.sourceDisplayName} / ${request.payload.serverDisplayName}: ${request.payload.toolDisplayName}`;
    case "skill":
      return `${request.payload.skillDisplayName}: ${request.payload.action}`;
    case "networkAccess":
      return request.payload.actionSummary;
  }
}

function approvalOptionButtonClass(
  kind: PendingApprovalView["presentation"]["decisionOptions"][number]["kind"],
): string {
  if (kind === "decline" || kind === "cancel") {
    return "secondary-button danger";
  }
  return "primary-button compact";
}

export function defaultGrantedPermissions(
  approval: PendingApprovalView,
  optionKind: PendingApprovalView["presentation"]["decisionOptions"][number]["kind"],
) {
  if (optionKind !== "grantPermissions") return null;
  const request = approval.presentation;
  switch (request.category) {
    case "commandExecution":
    case "fileChange":
      return request.payload.additionalPermissions;
    case "permissions":
      return request.payload.permissions;
    case "skill":
      return request.payload.requiredPermissions;
    case "remoteToolCall":
    case "networkAccess":
      return null;
  }
}
