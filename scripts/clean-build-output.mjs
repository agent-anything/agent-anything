import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { discoverWorkspacePackages } from "./architecture/WorkspaceDiscovery.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

for (const workspacePackage of discoverWorkspacePackages(repoRoot)) {
  rmSync(join(workspacePackage.root, "dist"), {
    recursive: true,
    force: true,
  });
}
