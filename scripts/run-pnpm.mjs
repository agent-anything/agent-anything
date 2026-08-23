import { spawnSync } from "node:child_process";

const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry || !pnpmEntry.toLowerCase().includes("pnpm")) {
  console.error("Workspace scripts must be started through pnpm.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [pnpmEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
