import { describe, expect, it } from "vitest";
import { interpretShellCommandOutcome } from "./ShellCommandOutcome.js";

describe("interpretShellCommandOutcome", () => {
  it("treats the conventional zero exit code as success", () => {
    expect(interpret("Bash", "dotnet run", 0)).toEqual({
      status: "succeeded",
      interpretation: null,
    });
  });

  it("turns a nonzero exit into a failed semantic outcome with diagnostics", () => {
    const outcome = interpret(
      "PowerShell",
      "dotnet new console --name HelloWorldApp",
      73,
      "The template could not be created.",
    );

    expect(outcome).toMatchObject({
      status: "failed",
      code: "command_exit_nonzero",
    });
    if (outcome.status === "failed") {
      expect(outcome.message).toContain("exit code 73");
      expect(outcome.message).toContain("The template could not be created.");
    }
  });

  it.each([
    ["Bash", "rg missing src", "No matches found."],
    ["Bash", "cd src && rg missing .", "No matches found."],
    ["Bash", "diff expected.txt actual.txt", "The compared files differ."],
    ["PowerShell", "findstr missing file.txt", "No matches found."],
  ] as const)(
    "accepts the informational exit code for %s command %s",
    (shell, command, interpretation) => {
      expect(interpret(shell, command, 1)).toEqual({
        status: "succeeded",
        interpretation,
      });
    },
  );

  it("uses Robocopy's documented success range", () => {
    expect(interpret("PowerShell", "robocopy source target", 7)).toMatchObject({
      status: "succeeded",
    });
    expect(interpret("PowerShell", "robocopy source target", 8)).toMatchObject({
      status: "failed",
      code: "command_exit_nonzero",
    });
  });

  it("fails when a foreground process has no usable exit code", () => {
    expect(interpret("Bash", "dotnet run", null)).toMatchObject({
      status: "failed",
      code: "command_exit_unavailable",
    });
  });

  it("bounds retained command diagnostics", () => {
    const outcome = interpret(
      "Bash",
      "dotnet run",
      1,
      "x".repeat(40_000),
      true,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.message.length).toBeLessThanOrEqual(16_384);
      expect(outcome.message).toContain("diagnostic truncated");
      expect(outcome.message).toContain("capture truncated");
    }
  });

  it("labels inferred diagnostics without changing exit semantics", () => {
    const outcome = interpretShellCommandOutcome({
      shell: "PowerShell",
      command: "dotnet run",
      exitCode: 1,
      signal: null,
      stdout: stream("", false),
      stderr: {
        ...stream("localized diagnostic", false),
        encoding: "windows-1251",
        encodingSource: "detected",
        integrity: "inferred",
      },
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.message).toContain("text encoding inferred as windows-1251");
    }
  });
});

function interpret(
  shell: "Bash" | "PowerShell",
  command: string,
  exitCode: number | null,
  stderr = "",
  stderrTruncated = false,
) {
  return interpretShellCommandOutcome({
    shell,
    command,
    exitCode,
    signal: null,
    stdout: stream("", false),
    stderr: stream(stderr, stderrTruncated),
  });
}

function stream(text: string, truncated: boolean) {
  return {
    text,
    encoding: "utf-8",
    encodingSource: "utf8" as const,
    integrity: "exact" as const,
    replacementCount: 0,
    truncated,
  };
}
