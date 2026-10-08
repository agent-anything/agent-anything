import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WindowsCredentialBackend } from "./ProviderCredentialStore.js";

const defaultDirectory = fileURLToPath(new URL("../../../native-artifacts/win32-x64/", import.meta.url));
export async function resolveWindowsCredentialHelper(directory = defaultDirectory): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows credential storage is unavailable.");
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    const path = await realpath(join(directory, "helarc-credential-helper.exe"));
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (manifest.protocol !== 1 || manifest.build !== "0.1.0" || manifest.architecture !== "x64" || manifest.sha256 !== digest || path.toLowerCase().includes(".asar\\")) throw new Error();
    return path;
  } catch { throw new Error("Build the Windows credential helper before using Windows credential storage."); }
}

export class NativeWindowsCredentialBackend implements WindowsCredentialBackend {
  constructor(private readonly directory = defaultDirectory) {}
  async available() { try { await resolveWindowsCredentialHelper(this.directory); return true; } catch { return false; } }
  async read(target: string, encoding: "utf16le" | "utf8") {
    const result = await this.request({ operation: "read", target, encoding });
    if (result.secret !== null && typeof result.secret !== "string") throw new Error("Invalid credential response.");
    return result.secret as string | null;
  }
  async create(target: string, secret: string) { await this.request({ operation: "create", target, secret }); }
  async delete(target: string) { await this.request({ operation: "delete", target }); }
  private async request(request: Record<string, string>): Promise<Record<string, unknown>> {
    const path = await resolveWindowsCredentialHelper(this.directory);
    const bytes = Buffer.from(JSON.stringify(request));
    if (bytes.length > 32768) throw new Error("Credential request is too large.");
    return new Promise((resolve, reject) => {
      const child = spawn(path, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let length = 0, failed = false;
      const fail = () => { if (failed) return; failed = true; clearTimeout(timer); child.kill(); reject(new Error("Windows credential operation failed.")); };
      const timer = setTimeout(fail, 10000);
      child.on("error", fail); child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 32768) fail(); else chunks.push(chunk); });
      child.on("close", code => {
        clearTimeout(timer); bytes.fill(0);
        let output: Buffer | undefined;
        try {
          if (failed) return;
          if (code !== 0) throw new Error();
          output = Buffer.concat(chunks);
          const result = JSON.parse(output.toString("utf8"));
          if (!result || result.ok !== true) throw new Error();
          resolve(result);
        } catch { fail(); }
        finally {
          output?.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      });
      child.stdin.end(bytes);
    });
  }
}
