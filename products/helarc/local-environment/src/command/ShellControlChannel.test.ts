import { spawnSync } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandWithFinalWorkingDirectory,
  consumeFinalWorkingDirectory,
} from "./LocalCommandActionCapability.js";
import { selectNativeShell, resolveCommandExecutable } from "./CommandActionIdentity.js";
import { WindowsJobProcessBackend, resolveWindowsProcessHelper } from "./WindowsJobProcessBackend.js";
import { PosixProcessBackend } from "./PosixProcessBackend.js";

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
      const backend = process.platform === "win32"
        ? new WindowsJobProcessBackend(await resolveWindowsProcessHelper())
        : new PosixProcessBackend();
      const chunks: Buffer[] = [];
      let finish!: () => void;
      const closed = new Promise<void>(resolve => { finish = resolve; });
      const executable = await resolveCommandExecutable({command:shell.command,cwd:process.cwd(),platform,environment});
      const handle = await backend.launch({
        executionId: "cwd-test", executable: executable.canonicalPath,
        args: [...shell.argumentsBeforeCommand, commandWithFinalWorkingDirectory(shell.toolName, command, controlPath)],
        cwd: process.cwd(), environment, signal: controller.signal, startupTimeoutMs: 3000,
      }, event => {
        if(event.kind === "output" && event.stream === "stdout") chunks.push(Buffer.from(event.bytes));
        if(event.kind === "output_closed") finish();
      });
      await closed;
      await handle.close();
      const stdout = Buffer.concat(chunks).toString("utf8");
      expect(stdout).toContain("visible");
      expect(stdout).not.toContain("HELARC_FINAL_CWD");
      await expect(consumeFinalWorkingDirectory(controlPath)).resolves.toBe(
        await realpath(process.cwd()),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")("PowerShell command sequencing", () => {
  it.each([
    { behavior: "continues after a non-terminating error", errorAction: "", exitCode: 0, stdout: "42" },
    { behavior: "honors an explicit terminating error", errorAction: " -ErrorAction Stop", exitCode: 1, stdout: "" },
  ])("$behavior without changing native semantics", async ({ errorAction, exitCode, stdout }) => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-shell-sequencing-"));
    const controlPath = join(directory, "cwd.txt");
    try {
      const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const command = `Set-Location -LiteralPath './missing-directory'${errorAction}; & '${process.execPath.replaceAll("'", "''")}' -e 'console.log(42)'`;

      for (const source of [command, commandWithFinalWorkingDirectory("PowerShell", command, controlPath)]) {
        const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source], {
          cwd: directory,
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(exitCode);
        expect(result.stdout.trim()).toBe(stdout);
        expect(result.stderr).toContain("PathNotFound");
      }

      if (exitCode === 0) {
        await expect(consumeFinalWorkingDirectory(controlPath)).resolves.toBe(
          await realpath(directory),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
