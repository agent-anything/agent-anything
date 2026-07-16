import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import {
  delimiter,
  extname,
  isAbsolute,
  resolve,
  sep,
} from "node:path";
import {
  createCanonicalSha256Digest,
  type CanonicalExecutableIdentityInput,
  type FileBaseline,
} from "@agent-anything/agent-core/action-execution";

type FileSystemPlatform = "win32" | "posix";

export interface CommandEnvironmentPolicySnapshot {
  readonly id: string;
  readonly digest: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface PreparedCommandExecutable {
  readonly identity: CanonicalExecutableIdentityInput;
  readonly canonicalPath: string;
}

export async function createCommandEnvironmentPolicy(input: {
  readonly id: string;
  readonly overrides?: Readonly<Record<string, string>>;
}): Promise<CommandEnvironmentPolicySnapshot> {
  if (!isToken(input.id)) throw new TypeError("Command environment policy id is invalid.");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    if (name.length === 0 || typeof value !== "string") {
      throw new TypeError("Command environment overrides must use non-empty names and text values.");
    }
    environment[name] = value;
  }
  const snapshot = Object.freeze(Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
  ));
  return Object.freeze({
    id: input.id,
    digest: await createCanonicalSha256Digest(
      "agent-anything.code-agent.command-environment.v1",
      snapshot,
    ),
    environment: snapshot,
  });
}

export async function resolveCommandExecutable(input: {
  readonly command: string;
  readonly cwd: string;
  readonly platform: FileSystemPlatform;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<PreparedCommandExecutable> {
  const candidate = await findExecutableCandidate(input);
  const canonicalPath = await realpath(candidate);
  await access(canonicalPath, constants.X_OK);
  const stats = await stat(canonicalPath);
  if (!stats.isFile()) throw new TypeError("Resolved command does not identify an executable file.");
  const baseline = await fileBaseline(canonicalPath, stats, input.platform);
  const resolutionFingerprint = await createCanonicalSha256Digest(
    "agent-anything.code-agent.command-resolution.v1",
    {
      platform: input.platform,
      command: input.command,
      cwd: normalizePath(input.cwd, input.platform),
      resolvedPath: normalizePath(canonicalPath, input.platform),
    },
  );
  return Object.freeze({
    canonicalPath,
    identity: Object.freeze({
      path: Object.freeze({
        platform: input.platform,
        path: canonicalPath,
        resolvedPath: canonicalPath,
        workspaceRootId: null,
        resolutionFingerprint,
      }),
      baseline,
    }),
  });
}

export async function revalidateCommandExecutable(input: {
  readonly originalCommand: string;
  readonly expectedPath: string;
  readonly cwd: string;
  readonly platform: FileSystemPlatform;
}): Promise<PreparedCommandExecutable> {
  const canonicalPath = await realpath(input.expectedPath);
  await access(canonicalPath, constants.X_OK);
  const stats = await stat(canonicalPath);
  if (!stats.isFile()) throw new TypeError("Command executable is no longer a file.");
  return Object.freeze({
    canonicalPath,
    identity: Object.freeze({
      path: Object.freeze({
        platform: input.platform,
        path: canonicalPath,
        resolvedPath: canonicalPath,
        workspaceRootId: null,
        resolutionFingerprint: await createCanonicalSha256Digest(
          "agent-anything.code-agent.command-resolution.v1",
          {
            platform: input.platform,
            command: input.originalCommand,
            cwd: normalizePath(input.cwd, input.platform),
            resolvedPath: normalizePath(canonicalPath, input.platform),
          },
        ),
      }),
      baseline: await fileBaseline(canonicalPath, stats, input.platform),
    }),
  });
}

async function findExecutableCandidate(input: {
  readonly command: string;
  readonly cwd: string;
  readonly platform: FileSystemPlatform;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<string> {
  if (isAbsolute(input.command)) return input.command;
  if (input.command.includes("/") || input.command.includes("\\")) {
    return resolve(input.cwd, input.command);
  }
  const pathValue = environmentValue(input.environment, "PATH", input.platform) ?? "";
  const extensions = executableExtensions(input);
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, input.command + extension);
      try {
        await access(candidate, constants.X_OK);
        const stats = await stat(candidate);
        if (stats.isFile()) return candidate;
      } catch {
        // Continue through the trusted PATH snapshot.
      }
    }
  }
  throw new TypeError(`Command executable '${input.command}' could not be resolved.`);
}

function executableExtensions(input: {
  readonly command: string;
  readonly platform: FileSystemPlatform;
  readonly environment: Readonly<Record<string, string>>;
}): readonly string[] {
  if (input.platform !== "win32" || extname(input.command).length > 0) return [""];
  const pathExt = environmentValue(input.environment, "PATHEXT", input.platform) ??
    ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean).map((value) => value.toLowerCase());
}

function environmentValue(
  environment: Readonly<Record<string, string>>,
  name: string,
  platform: FileSystemPlatform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const found = Object.entries(environment).find(([candidate]) =>
    candidate.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

async function fileBaseline(
  path: string,
  stats: Stats,
  platform: FileSystemPlatform,
): Promise<FileBaseline & { readonly kind: "present"; readonly entryKind: "file" }> {
  return Object.freeze({
    kind: "present" as const,
    entryKind: "file" as const,
    objectIdentity: platform === "win32"
      ? Object.freeze({ kind: "win32" as const, volumeId: String(stats.dev), fileId: String(stats.ino) })
      : Object.freeze({ kind: "posix" as const, deviceId: String(stats.dev), inode: String(stats.ino) }),
    contentDigest: `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`,
  });
}

function normalizePath(value: string, platform: FileSystemPlatform): string {
  const normalized = platform === "win32" ? value.split(sep).join("/") : value;
  return platform === "win32" && /^[a-z]:/.test(normalized)
    ? normalized[0]!.toUpperCase() + normalized.slice(1)
    : normalized;
}

function isToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}
