import { spawnSync } from "node:child_process";
import { extname } from "node:path";

const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry || !pnpmEntry.toLowerCase().includes("pnpm")) {
  console.error("Workspace scripts must be started through pnpm.");
  process.exit(1);
}

const pnpmEntryExtension = extname(pnpmEntry).toLowerCase();
const isJavaScriptEntry = [".cjs", ".js", ".mjs"].includes(pnpmEntryExtension);
const command = isJavaScriptEntry ? process.execPath : pnpmEntry;
const args = isJavaScriptEntry
  ? [pnpmEntry, ...process.argv.slice(2)]
  : process.argv.slice(2);

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === "win32" && [".bat", ".cmd"].includes(pnpmEntryExtension),
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
