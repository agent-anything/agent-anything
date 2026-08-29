import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandWithFinalWorkingDirectory,
  consumeFinalWorkingDirectory,
} from "./LocalCommandActionCapability.js";
import { selectNativeShell } from "./CommandActionIdentity.js";
import { executeProcess } from "./ProcessExecutor.js";

describe("Shell final-working-directory control channel", () => {
  it("keeps PowerShell control data out of stdout", () => {
    const command = commandWithFinalWorkingDirectory(
      "PowerShell",
      "Set-Location src; dotnet test",
      "C:\\Temp\\helarc-cwd.txt",
    );

    expect(command).toContain("Out-File -LiteralPath 'C:\\Temp\\helarc-cwd.txt'");
    expect(command).toContain("[Console]::OutputEncoding = $__helarc_utf8");
    expect(command).not.toContain("[Console]::Out.WriteLine");
  });

  it("strictly consumes and removes one bounded UTF-8 control file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-cwd-control-"));
    const controlPath = join(directory, "cwd.txt");
    try {
      await writeFile(controlPath, Buffer.from("C:\\workspace\\src", "utf8"));
      await expect(consumeFinalWorkingDirectory(controlPath)).resolves.toBe(
        "C:\\workspace\\src",
      );
      await expect(access(controlPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalidly encoded control data and still removes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-cwd-control-"));
    const controlPath = join(directory, "cwd.txt");
    try {
      await writeFile(controlPath, Buffer.from([0xff, 0xfe, 0xfd]));
      await expect(consumeFinalWorkingDirectory(controlPath)).resolves.toBeNull();
      await expect(access(controlPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("captures cwd through the selected real shell without polluting stdout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-cwd-shell-"));
    const controlPath = join(directory, "cwd.txt");
    try {
      const platform = process.platform === "win32" ? "win32" : "posix";
      const environment = Object.freeze(Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ));
      const shell = await selectNativeShell({
        platform,
        cwd: process.cwd(),
        environment,
      });
      const command = shell.toolName === "PowerShell"
        ? "Write-Output 'visible'"
        : "printf 'visible\\n'";
      const controller = new AbortController();
      const outcome = await executeProcess({
        command: shell.command,
        args: [
          ...shell.argumentsBeforeCommand,
          commandWithFinalWorkingDirectory(shell.toolName, command, controlPath),
        ],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maxStdoutBytes: 10_000,
        maxStderrBytes: 10_000,
        interruption: {
          signal: controller.signal,
          get interruption() { return null; },
        },
        termination: { gracePeriodMs: 500, forceKillTimeoutMs: 2_000 },
        startedMs: 0,
        nowMs: () => 1,
      });

      expect(outcome).toMatchObject({
        kind: "completed",
        exitCode: 0,
        stdout: { text: expect.stringContaining("visible") },
      });
      if (outcome.kind !== "completed") throw new Error("Expected shell completion.");
      expect(outcome.stdout.text).not.toContain("HELARC_FINAL_CWD");
      await expect(consumeFinalWorkingDirectory(controlPath)).resolves.toBe(
        await realpath(process.cwd()),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
