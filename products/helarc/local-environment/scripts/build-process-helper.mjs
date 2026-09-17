import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("Windows helper is not required by the POSIX backend.");
} else {
  if (process.arch !== "x64") throw new Error("Only the Windows x64 helper target is qualified.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const crate = join(root, "native/process-helper");
  const result = spawnSync("cargo", ["build", "--locked", "--release", "--target", "x86_64-pc-windows-msvc", "--bins"],
    { cwd: crate, stdio: "inherit", windowsHide: true, shell: false });
  if (result.error) throw new Error(`Native build requires pinned Rust/MSVC and Windows SDK: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  const directory = join(root, "native-artifacts/win32-x64"); await mkdir(directory, { recursive: true });
  const source = join(crate, "target/x86_64-pc-windows-msvc/release");
  for (const name of ["helarc-process-helper.exe", "process-fixture.exe"]) await copyFile(join(source, name), join(directory, name));
  const bytes = await readFile(join(directory, "helarc-process-helper.exe"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ protocol: 1, build: "0.1.0", architecture: "x64",
    sha256: createHash("sha256").update(bytes).digest("hex") }, null, 2) + "\n");
}
