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
        ? "[pscustomobject]@{ Marker = 'visible'; Count = 42 }"
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
      if (shell.toolName === "PowerShell") expect(stdout).toContain("42");
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

describe.skipIf(process.platform !== "win32").each(["foreground", "background"])("PowerShell %s wrapper", mode => {
  const objectCommand = "[pscustomobject]@{ Name = 'object-sentinel'; Count = 42 }";
  const nativeCommand = `& '${process.execPath.replaceAll("'", "''")}' -e`;

  it.each([
    { behavior: "drains default object formatting", command: objectCommand, stdout: ["Name", "Count", "object-sentinel", "42"], stderr: "", exitCode: 0 },
    { behavior: "drains explicitly buffered tables", command: `${objectCommand} | Format-Table -AutoSize`, stdout: ["Name", "Count", "object-sentinel", "42"], stderr: "", exitCode: 0 },
    { behavior: "drains output after an early return", command: `return (${objectCommand}); Write-Output 'unreachable-sentinel'`, stdout: ["object-sentinel", "42"], stderr: "", exitCode: 0 },
    { behavior: "reports a final non-terminating error", command: "Write-Error 'error-sentinel'", stdout: [], stderr: "error-sentinel", exitCode: 1 },
    { behavior: "captures status after a trailing comment", command: "Write-Error 'error-sentinel' # trailing comment", stdout: [], stderr: "error-sentinel", exitCode: 1 },
    { behavior: "reports a final cmdlet failure", command: "Get-Item -LiteralPath './missing-item'", stdout: [], stderr: "PathNotFound", exitCode: 1 },
    { behavior: "continues after a non-terminating error", command: `Write-Error 'error-sentinel'; ${objectCommand}`, stdout: ["object-sentinel", "42"], stderr: "error-sentinel", exitCode: 0 },
    { behavior: "preserves native success and output", command: `${nativeCommand} 'console.log(42)'`, stdout: ["42"], stderr: "", exitCode: 0 },
    { behavior: "mixed sequence: native zero does not mask a final cmdlet failure", command: `${nativeCommand} 'process.exit(0)'; Get-Item -LiteralPath './missing-item'`, stdout: [], stderr: "PathNotFound", exitCode: 1 },
    { behavior: "mixed sequence: native zero and a cmdlet failure allow later success", command: `${nativeCommand} 'process.exit(0)'; Get-Item -LiteralPath './missing-item'; ${objectCommand}`, stdout: ["object-sentinel", "42"], stderr: "PathNotFound", exitCode: 0 },
    { behavior: "mixed sequence: nonzero native exit retains precedence over a cmdlet failure", command: `${nativeCommand} 'process.exit(7)'; Get-Item -LiteralPath './missing-item'`, stdout: [], stderr: "PathNotFound", exitCode: 7 },
    { behavior: "preserves an exact nonzero native exit", command: `${nativeCommand} 'console.log(42); process.exit(7)'`, stdout: ["42"], stderr: "", exitCode: 7 },
    { behavior: "preserves native exit state after object output", command: `${nativeCommand} 'process.exit(7)'; ${objectCommand}`, stdout: ["object-sentinel", "42"], stderr: "", exitCode: 7 },
    { behavior: "preserves native exit state after an early return", command: `${nativeCommand} 'process.exit(7)'; return; Write-Output 'unreachable-sentinel'`, stdout: [], stderr: "", exitCode: 7 },
    { behavior: "keeps stdout and stderr separate", command: `${nativeCommand} 'console.log(42); console.error(73); process.exit(9)'`, stdout: ["42"], stderr: "73", exitCode: 9 },
  ])("$behavior", async ({ command, stdout, stderr, exitCode }) => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-shell-output-"));
    const controlPath = join(directory, "cwd.txt");
    try {
      const result = runWindowsPowerShell(commandWithFinalWorkingDirectory(
        "PowerShell", command, mode === "foreground" ? controlPath : null,
      ), directory);

      expect(result.status).toBe(exitCode);
      if (stdout.length === 0) expect(result.stdout).toBe("");
      for (const text of stdout) expect(result.stdout).toContain(text);
      if (stderr === "") expect(result.stderr).toBe("");
      else {
        expect(result.stderr).toContain(stderr);
        expect(result.stdout).not.toContain(stderr);
      }
      expect(result.stdout).not.toContain(directory);
      expect(result.stdout).not.toContain("__helarc");
      expect(result.stdout).not.toContain("unreachable-sentinel");
      await expect(consumeFinalWorkingDirectory(controlPath)).resolves.toBe(
        mode === "foreground" ? await realpath(directory) : null,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { behavior: "explicit successful exit", ending: "exit 0", exitCode: 0, stderr: "" },
    { behavior: "explicit failing exit", ending: "exit 7", exitCode: 7, stderr: "" },
    { behavior: "throw", ending: "throw 'throw-sentinel'", exitCode: 1, stderr: "throw-sentinel" },
    { behavior: "explicit terminating cmdlet error", ending: "Write-Error 'stop-sentinel' -ErrorAction Stop", exitCode: 1, stderr: "stop-sentinel" },
  ])("preserves native $behavior semantics", async ({ ending, exitCode, stderr }) => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-shell-termination-"));
    const controlPath = join(directory, "cwd.txt");
    try {
      const command = `${objectCommand}; ${ending}; Write-Output 'unreachable-sentinel'`;
      const direct = runWindowsPowerShell(command, directory);
      const wrapped = runWindowsPowerShell(commandWithFinalWorkingDirectory(
        "PowerShell", command, mode === "foreground" ? controlPath : null,
      ), directory);

      expect(direct.status).toBe(exitCode);
      expect(wrapped.status).toBe(direct.status);
      // Native exit/throw can discard buffered formatting; the wrapper must not promise a drain there.
      expect(wrapped.stdout).toBe(direct.stdout);
      expect(wrapped.stdout).not.toContain("unreachable-sentinel");
      if (stderr === "") expect(wrapped.stderr).toBe("");
      else {
        expect(direct.stderr).toContain(stderr);
        expect(wrapped.stderr).toContain(stderr);
      }
      await expect(access(controlPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function runWindowsPowerShell(command: string, cwd: string) {
  const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd, encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
