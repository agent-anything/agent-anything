import { realpath, stat } from "node:fs/promises";
import { isAbsolute, delimiter } from "node:path";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import {
  createCommandEnvironmentPolicy, resolveCommandExecutable,
  type CommandEnvironmentPolicySnapshot, type NativeShellSelection, type PreparedCommandExecutable,
} from "./CommandActionIdentity.js";

export interface CommandPathDependency {
  readonly entry: string;
  readonly target: {readonly path: string; readonly device: string; readonly inode: string; readonly directory: boolean} | null;
}

export interface CommandEnvironmentRecoverySnapshot extends CommandEnvironmentPolicySnapshot {
  readonly version: 1;
  readonly paths: readonly CommandPathDependency[];
  readonly shell: {readonly selection: NativeShellSelection; readonly executable: PreparedCommandExecutable};
}

export class CommandEnvironmentRecoveryError extends Error {
  constructor(readonly code: string, readonly component: string) {
    super(`Original command environment is unavailable: ${component} (${code}).`);
    this.name = "CommandEnvironmentRecoveryError";
  }
}

async function dependency(entry: string): Promise<CommandPathDependency> {
  try {
    const path = await realpath(entry);
    const value = await stat(path, {bigint: true});
    return {entry, target: {path, device: String(value.dev), inode: String(value.ino), directory: value.isDirectory()}};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return {entry, target: null};
    throw new CommandEnvironmentRecoveryError("command_dependency_unreadable", "PATH");
  }
}

function absolutePathEntries(environment: Readonly<Record<string, string>>): readonly string[] {
  const path = Object.entries(environment).find(([key]) => process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH")?.[1] ?? "";
  return path.split(delimiter).filter(entry => isAbsolute(entry));
}

export async function captureCommandEnvironmentRecovery(input: {
  readonly environment: CommandEnvironmentPolicySnapshot;
  readonly shell: NativeShellSelection;
  readonly cwd: string;
  readonly platform: "win32" | "posix";
}): Promise<CommandEnvironmentRecoverySnapshot> {
  const paths: CommandPathDependency[] = [];
  for (const entry of absolutePathEntries(input.environment.environment)) paths.push(await dependency(entry));
  return Object.freeze({...input.environment, version: 1, paths: Object.freeze(paths), shell: {
    selection: input.shell,
    executable: await resolveCommandExecutable({command: input.shell.command, cwd: input.cwd,
      platform: input.platform, environment: input.environment.environment}),
  }});
}

export async function restoreCommandEnvironmentRecovery(input: {
  readonly snapshot: CommandEnvironmentRecoverySnapshot;
  readonly policyId: string;
  readonly cwd: string;
  readonly platform: "win32" | "posix";
}): Promise<CommandEnvironmentPolicySnapshot> {
  const saved = input.snapshot;
  if (!saved || saved.version !== 1 || saved.id !== input.policyId || !saved.environment || !Array.isArray(saved.paths) || !saved.shell)
    throw new CommandEnvironmentRecoveryError("command_environment_snapshot_invalid", "snapshot");
  const environment = await createCommandEnvironmentPolicy({id: saved.id, retained: saved.environment});
  if (environment.digest !== saved.digest) throw new CommandEnvironmentRecoveryError("command_environment_digest_mismatch", "environment");
  if (JSON.stringify(absolutePathEntries(environment.environment)) !== JSON.stringify(saved.paths.map(path => path.entry)))
    throw new CommandEnvironmentRecoveryError("command_environment_snapshot_invalid", "PATH");
  for (let index = 0; index < saved.paths.length; index++) {
    const expected = saved.paths[index]!;
    const current = await dependency(expected.entry);
    if (current.target?.path !== expected.target?.path || current.target?.device !== expected.target?.device ||
      current.target?.inode !== expected.target?.inode || current.target?.directory !== expected.target?.directory)
      throw new CommandEnvironmentRecoveryError("command_path_dependency_changed", `PATH[${index}]`);
  }
  try {
    const executable = await resolveCommandExecutable({command: saved.shell.selection.command, cwd: input.cwd,
      platform: input.platform, environment: environment.environment});
    if (Buffer.compare(Buffer.from(canonicalEncode("helarc.command-executable.v1", executable)), Buffer.from(canonicalEncode("helarc.command-executable.v1", saved.shell.executable))) !== 0)
      throw new Error("changed");
  } catch { throw new CommandEnvironmentRecoveryError("command_shell_dependency_changed", "shell"); }
  return environment;
}
