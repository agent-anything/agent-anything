export const HELARC_SHELL_COMMAND_OUTCOME_REVISION =
  "helarc.shell-command-outcome.v1";

const MAX_DIAGNOSTIC_CHARACTERS = 16_384;
const MAX_STREAM_CHARACTERS = 7_500;

export interface ShellCommandOutcomeInput {
  readonly shell: "Bash" | "PowerShell";
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type ShellCommandOutcome =
  | {
      readonly status: "succeeded";
      readonly interpretation: string | null;
    }
  | {
      readonly status: "failed";
      readonly code: "command_exit_nonzero" | "command_exit_unavailable";
      readonly message: string;
    };

interface ExitCodeSemantics {
  readonly failed: boolean;
  readonly interpretation: string | null;
}

export function interpretShellCommandOutcome(
  input: ShellCommandOutcomeInput,
): ShellCommandOutcome {
  if (input.exitCode === null) {
    return Object.freeze({
      status: "failed" as const,
      code: "command_exit_unavailable" as const,
      message: commandFailureMessage(
        input,
        input.signal === null
          ? "The shell command completed without a usable exit code."
          : `The shell command ended with signal ${input.signal} and no usable exit code.`,
      ),
    });
  }

  const semantics = input.shell === "PowerShell"
    ? powerShellSemantics(input.command, input.exitCode)
    : bashSemantics(input.command, input.exitCode);
  if (!semantics.failed) {
    return Object.freeze({
      status: "succeeded" as const,
      interpretation: semantics.interpretation,
    });
  }

  return Object.freeze({
    status: "failed" as const,
    code: "command_exit_nonzero" as const,
    message: commandFailureMessage(
      input,
      `The shell command failed with exit code ${input.exitCode}.`,
    ),
  });
}

function bashSemantics(command: string, exitCode: number): ExitCodeSemantics {
  const name = bashCommandName(command);
  if (name === "grep" || name === "rg") {
    return informationalExitCode(exitCode, 2, "No matches found.");
  }
  if (name === "find") {
    return informationalExitCode(
      exitCode,
      2,
      "The search completed, but some directories were inaccessible.",
    );
  }
  if (name === "diff") {
    return informationalExitCode(exitCode, 2, "The compared files differ.");
  }
  if (name === "test" || name === "[") {
    return informationalExitCode(exitCode, 2, "The tested condition is false.");
  }
  return defaultSemantics(exitCode);
}

function powerShellSemantics(
  command: string,
  exitCode: number,
): ExitCodeSemantics {
  const name = powerShellCommandName(command);
  if (name === "grep" || name === "rg" || name === "findstr") {
    return informationalExitCode(exitCode, 2, "No matches found.");
  }
  if (name === "robocopy") {
    if (exitCode >= 8) return failedSemantics();
    if (exitCode === 0) return succeededSemantics("No files required copying.");
    return succeededSemantics(
      (exitCode & 1) === 1
        ? "Robocopy copied files without a reported failure."
        : "Robocopy completed without a reported failure.",
    );
  }
  return defaultSemantics(exitCode);
}

function informationalExitCode(
  exitCode: number,
  failureThreshold: number,
  interpretation: string,
): ExitCodeSemantics {
  if (exitCode >= failureThreshold) return failedSemantics();
  return succeededSemantics(exitCode === 0 ? null : interpretation);
}

function defaultSemantics(exitCode: number): ExitCodeSemantics {
  return exitCode === 0 ? succeededSemantics(null) : failedSemantics();
}

function succeededSemantics(
  interpretation: string | null,
): ExitCodeSemantics {
  return Object.freeze({ failed: false, interpretation });
}

function failedSemantics(): ExitCodeSemantics {
  return Object.freeze({ failed: true, interpretation: null });
}

function bashCommandName(command: string): string {
  return executableName(lastCommandSegment(command), false);
}

function powerShellCommandName(command: string): string {
  const segment = lastCommandSegment(command).replace(/^[&.]\s+/u, "");
  return executableName(segment, true);
}

// This heuristic affects result interpretation only. It is never an authority or
// security decision; an unrecognized command falls back to conventional semantics.
function lastCommandSegment(command: string): string {
  const segments = command
    .split(/&&|\|\||[;|\n]/u)
    .filter((candidate) => candidate.trim());
  return segments.at(-1) ?? command;
}

function executableName(segment: string, windows: boolean): string {
  const token = segment.trim().split(/\s+/u)[0] ?? "";
  const unquoted = token.replace(/^["']|["']$/gu, "");
  const name = unquoted.split(/[\\/]/u).at(-1) ?? unquoted;
  return windows ? name.toLowerCase().replace(/\.exe$/u, "") : name;
}

function commandFailureMessage(
  input: ShellCommandOutcomeInput,
  headline: string,
): string {
  const sections = [headline];
  appendStream(
    sections,
    "stdout",
    input.stdout,
    input.stdoutTruncated,
  );
  appendStream(
    sections,
    "stderr",
    input.stderr,
    input.stderrTruncated,
  );
  return boundedText(sections.join("\n\n"), MAX_DIAGNOSTIC_CHARACTERS);
}

function appendStream(
  sections: string[],
  name: "stdout" | "stderr",
  value: string,
  captureTruncated: boolean,
): void {
  if (value.length === 0 && !captureTruncated) return;
  const body = boundedText(value, MAX_STREAM_CHARACTERS);
  const suffix = captureTruncated ? "\n[capture truncated]" : "";
  sections.push(`${name}:\n${body}${suffix}`);
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "\n... [diagnostic truncated] ...\n";
  const retained = maximum - marker.length;
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}
