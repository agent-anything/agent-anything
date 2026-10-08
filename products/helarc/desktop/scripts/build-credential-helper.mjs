import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.platform === "win32") {
  if (process.arch !== "x64") throw new Error("The Windows credential helper requires x64.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const crate = join(root, "native/credential-helper");
  const result = spawnSync("cargo", ["build", "--locked", "--release", "--target", "x86_64-pc-windows-msvc"],
    { cwd: crate, stdio: "inherit", windowsHide: true, shell: false });
  if (result.error) throw new Error("Credential helper build requires the repository Rust/MSVC toolchain.");
  if (result.status !== 0) process.exit(result.status ?? 1);
  const directory = join(root, "native-artifacts/win32-x64");
  await mkdir(directory, { recursive: true });
  const name = "helarc-credential-helper.exe";
  await copyFile(join(crate, "target/x86_64-pc-windows-msvc/release", name), join(directory, name));
  const bytes = await readFile(join(directory, name));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ protocol: 1, build: "0.1.0", architecture: "x64",
    sha256: createHash("sha256").update(bytes).digest("hex") }, null, 2) + "\n");
}
