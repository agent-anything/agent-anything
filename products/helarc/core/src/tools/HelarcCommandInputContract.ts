import type { ToolInputIssue, ToolInputSemanticValidation, ToolInputSemanticValidator } from "@agent-anything/tools/validation";
import type { ToolJsonObject } from "@agent-anything/tools/catalog";

/** Consumption port. Effective values and checking remain owned by the command capability. */
export interface HelarcCommandInputContract {
  readonly ref: {readonly owner: string; readonly kind: string; readonly id: string; readonly revision: string};
  readonly constraints: {
    readonly timeout: {readonly minimumMs: number; readonly maximumMs: number; readonly defaultMs: number};
    readonly wait: {readonly minimumPositiveMs: number; readonly maximumMs: number; readonly defaultForegroundMs: number; readonly backgroundMs: number};
    readonly command: {readonly maximumUtf8Bytes: number};
    readonly description: {readonly maximumUtf16CodeUnits: number};
    readonly capacity: {readonly maximumActive: number; readonly scope: "process_manager"};
  };
  validate(input: unknown): ToolInputSemanticValidation;
  issueHint(input: unknown, issue: ToolInputIssue): string | null;
}

export function commandInputSchema(contract: HelarcCommandInputContract): ToolJsonObject {
  const {timeout, wait, command, description, capacity} = contract.constraints;
  const schema: ToolJsonObject = {type: "object", additionalProperties: false, required: ["command"], properties: {
    command: {type: "string", minLength: 1, description: `Nonblank command; maximum ${command.maximumUtf8Bytes} UTF-8 bytes. The process manager allows ${capacity.maximumActive} active commands shared by Runs using that manager; admission checks current occupancy.`},
    description: {type: "string", minLength: 1, description: `Optional nonblank description; maximum ${description.maximumUtf16CodeUnits} UTF-16 code units.`},
    timeout_ms: {type: "integer", minimum: timeout.minimumMs, maximum: timeout.maximumMs, default: timeout.defaultMs,
      description: `Execution timeout in milliseconds: ${timeout.minimumMs} through ${timeout.maximumMs}; omission uses ${timeout.defaultMs}. Measured from process launch to root exit. Run cancellation and the earlier Run deadline still apply to all owned processes.`},
    wait_ms: {anyOf: [{type: "integer", const: 0}, {type: "integer", minimum: wait.minimumPositiveMs, maximum: wait.maximumMs}],
      description: `Observation wait only. Zero or ${wait.minimumPositiveMs} through ${wait.maximumMs} ms. Omission uses ${wait.defaultForegroundMs} ms for foreground, ${wait.backgroundMs} ms for background. Background requires omitted or zero wait. Ending this wait does not end command execution.`},
    run_in_background: {type: "boolean", description: "True returns after startup; wait_ms must be omitted or zero. It does not detach ownership or remove the execution deadline."},
  }};
  return Object.freeze(schema);
}

export function commandInputValidator(contract: HelarcCommandInputContract, tool: ToolInputSemanticValidator["tool"]): ToolInputSemanticValidator {
  return Object.freeze({ref: contract.ref, tool, validate: contract.validate, issueHint: contract.issueHint,
    configuration: Object.freeze({ref: contract.ref, value: contract.constraints as unknown as ToolJsonObject})});
}
