import type {
  InteractionApplyInput,
  InteractionCreateInput,
  InteractionProtocol,
  InteractionRequest,
  InteractionResolveInput,
} from "@agent-anything/interaction/protocol";
import { snapshotInteractionRequest } from "@agent-anything/interaction/protocol";
import type { InteractionProtocolRegistration } from "@agent-anything/interaction/coordination";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import { findHelarcBaselineToolContract } from "../tools/HelarcBaselineToolContracts.js";

export const HELARC_CLARIFICATION_PROTOCOL = Object.freeze({
  owner: "helarc",
  kind: "clarification",
  revision: "1",
});

export interface HelarcClarificationQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options?: readonly {
    readonly label: string;
    readonly description: string;
  }[];
  readonly allow_multiple: boolean;
}

export interface HelarcClarificationRequest {
  readonly questions: readonly HelarcClarificationQuestion[];
}

export interface HelarcClarificationAnswer {
  readonly question_id: string;
  readonly selected_labels: readonly string[];
  readonly text: string | null;
}

export interface HelarcClarificationSubmission {
  readonly answers: readonly HelarcClarificationAnswer[];
}

export interface HelarcClarificationResolution {
  readonly submission_id: string;
  readonly answers: readonly HelarcClarificationAnswer[];
}

export interface HelarcClarificationResult {
  readonly request_ref: string;
  readonly answers: readonly HelarcClarificationAnswer[];
}

export interface HelarcClarificationContribution {
  readonly protocol: InteractionProtocolRegistration<
    "clarification",
    HelarcClarificationRequest,
    HelarcClarificationRequest,
    HelarcClarificationSubmission,
    HelarcClarificationResolution,
    HelarcClarificationResult
  >;
  readonly tool: ToolRegistrationInput;
}

export function createHelarcClarificationContribution(
  admittedAt: string,
): HelarcClarificationContribution {
  const protocol: InteractionProtocol<
    "clarification",
    HelarcClarificationRequest,
    HelarcClarificationRequest,
    HelarcClarificationSubmission,
    HelarcClarificationResolution,
    HelarcClarificationResult
  > = Object.freeze({
    ref: HELARC_CLARIFICATION_PROTOCOL,
    createRequest(input: InteractionCreateInput<HelarcClarificationRequest, HelarcClarificationRequest>) {
      const subject = snapshotClarificationRequest(input.subject);
      const presentation = snapshotClarificationRequest(input.presentation);
      if (JSON.stringify(subject) !== JSON.stringify(presentation)) {
        throw new TypeError("Clarification presentation must match its Tool input.");
      }
      return snapshotInteractionRequest({
        ref: Object.freeze({
          id: input.requestId,
          protocol: HELARC_CLARIFICATION_PROTOCOL,
          requestVersion: input.requestVersion,
          subject: input.subjectRef,
        }),
        subject,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }, snapshotClarificationRequest, snapshotClarificationRequest);
    },
    validateSubmission(
      request: InteractionRequest<
        "clarification",
        HelarcClarificationRequest,
        HelarcClarificationRequest
      >,
      candidate: unknown,
    ) {
      return validateAnswersAgainstQuestions(
        snapshotClarificationSubmission(candidate),
        request.subject,
      );
    },
    resolve(input: InteractionResolveInput<
      "clarification",
      HelarcClarificationSubmission,
      HelarcClarificationRequest,
      HelarcClarificationRequest
    >) {
      return Object.freeze({
        submission_id: input.submissionId,
        answers: input.submission.answers,
      });
    },
    apply(input: InteractionApplyInput<
      "clarification",
      HelarcClarificationResolution,
      HelarcClarificationRequest,
      HelarcClarificationRequest
    >) {
      return Object.freeze({
        request_ref: `${input.request.ref.protocol.owner}:${input.request.ref.protocol.kind}:${input.request.ref.id}@${input.request.ref.requestVersion}`,
        answers: input.resolution.answers,
      });
    },
  });
  const contract = findHelarcBaselineToolContract("AskUserQuestion");
  return Object.freeze({
    protocol: Object.freeze({ ref: HELARC_CLARIFICATION_PROTOCOL, protocol }),
    tool: Object.freeze({
      admissionId: "helarc.ask-user-question.v1",
      descriptor: Object.freeze({
        ref: Object.freeze({
          tool: Object.freeze({ namespace: "helarc", name: "ask-user-question" }),
          revision: "1",
        }),
        name: contract.name,
        description: contract.description,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        schemaRevisions: Object.freeze({
          dialect: "json-schema-2020-12",
          input: "1",
          output: "1",
          translation: "native-1",
        }),
        annotations: contract.annotations,
        source: Object.freeze({
          kind: "product" as const,
          sourceId: "helarc",
          sourceRevision: "1",
          activationEpoch: null,
        }),
        binding: Object.freeze({
          kind: "interaction" as const,
          protocol: HELARC_CLARIFICATION_PROTOCOL,
          blockingScope: "run" as const,
          revision: "clarification-binding-1",
        }),
        retirement: null,
        metadata: Object.freeze({ profile: "code-agent" }),
      }),
      allowedOrigins: Object.freeze(["model" as const]),
      admittedAt,
    }),
  });
}

function validateAnswersAgainstQuestions(
  submission: HelarcClarificationSubmission,
  request: HelarcClarificationRequest,
): HelarcClarificationSubmission {
  if (submission.answers.length !== request.questions.length) {
    throw new TypeError("Clarification submission must answer every question exactly once.");
  }
  const answers = new Map(submission.answers.map((answer) => [answer.question_id, answer]));
  for (const question of request.questions) {
    const answer = answers.get(question.id);
    if (answer === undefined) throw new TypeError("Clarification answer does not match the active request.");
    if (!question.allow_multiple && answer.selected_labels.length > 1) {
      throw new TypeError("Clarification question allows at most one selected option.");
    }
    const labels = new Set(question.options?.map(({ label }) => label) ?? []);
    if (answer.selected_labels.some((label) => !labels.has(label))) {
      throw new TypeError("Clarification answer selects an option outside the active request.");
    }
  }
  return submission;
}

function snapshotClarificationRequest(candidate: unknown): HelarcClarificationRequest {
  const input = exactRecord(candidate, ["questions"], "Clarification request");
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) {
    throw new TypeError("Clarification request requires one to four questions.");
  }
  const ids = new Set<string>();
  const questions = input.questions.map((item, index) => {
    const question = exactRecord(item, ["id", "prompt", "options", "allow_multiple"], `questions[${index}]`);
    const id = boundedText(question.id, 128, `questions[${index}].id`);
    if (ids.has(id)) throw new TypeError("Clarification question ids must be unique.");
    ids.add(id);
    if (typeof question.allow_multiple !== "boolean") {
      throw new TypeError(`questions[${index}].allow_multiple must be boolean.`);
    }
    const options = question.options === undefined
      ? undefined
      : snapshotOptions(question.options, index);
    return Object.freeze({
      id,
      prompt: boundedText(question.prompt, 4_096, `questions[${index}].prompt`),
      ...(options === undefined ? {} : { options }),
      allow_multiple: question.allow_multiple,
    });
  });
  return Object.freeze({ questions: Object.freeze(questions) });
}

function snapshotOptions(candidate: unknown, questionIndex: number) {
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 8) {
    throw new TypeError(`questions[${questionIndex}].options requires one to eight entries.`);
  }
  const labels = new Set<string>();
  return Object.freeze(candidate.map((item, optionIndex) => {
    const option = exactRecord(item, ["label", "description"], `questions[${questionIndex}].options[${optionIndex}]`);
    const label = boundedText(option.label, 256, `questions[${questionIndex}].options[${optionIndex}].label`);
    if (labels.has(label)) throw new TypeError("Clarification option labels must be unique within a question.");
    labels.add(label);
    return Object.freeze({
      label,
      description: boundedText(option.description, 1_024, `questions[${questionIndex}].options[${optionIndex}].description`),
    });
  }));
}

function snapshotClarificationSubmission(candidate: unknown): HelarcClarificationSubmission {
  const input = exactRecord(candidate, ["answers"], "Clarification submission");
  if (!Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > 4) {
    throw new TypeError("Clarification submission requires one to four answers.");
  }
  const ids = new Set<string>();
  const answers = input.answers.map((item, index) => {
    const answer = exactRecord(item, ["question_id", "selected_labels", "text"], `answers[${index}]`);
    const questionId = boundedText(answer.question_id, 128, `answers[${index}].question_id`);
    if (ids.has(questionId)) throw new TypeError("Clarification answers must target unique questions.");
    ids.add(questionId);
    if (!Array.isArray(answer.selected_labels) || answer.selected_labels.length > 8) {
      throw new TypeError(`answers[${index}].selected_labels must be a bounded array.`);
    }
    const selectedLabels = Object.freeze(answer.selected_labels.map((label, labelIndex) =>
      boundedText(label, 256, `answers[${index}].selected_labels[${labelIndex}]`)
    ));
    const text = answer.text === null
      ? null
      : boundedText(answer.text, 4_096, `answers[${index}].text`);
    if (selectedLabels.length === 0 && text === null) {
      throw new TypeError("Each clarification answer requires a selected label or free text.");
    }
    return Object.freeze({ question_id: questionId, selected_labels: selectedLabels, text });
  });
  return Object.freeze({ answers: Object.freeze(answers) });
}

function exactRecord(candidate: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const record = candidate as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} contains an unsupported field.`);
  }
  return record;
}

function boundedText(candidate: unknown, maxLength: number, name: string): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maxLength || candidate !== candidate.trim()) {
    throw new TypeError(`${name} must be bounded non-empty text.`);
  }
  return candidate;
}
