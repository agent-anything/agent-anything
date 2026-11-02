import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: currentDir,
  esbuild: {
    jsx: "automatic",
  },
  // Cross-package integration consumes public builds, as the real Worker does.
  // Source aliases mix duplicate runtime identities with built test-support imports.
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    environment: "node",
    poolMatchGlobs: [["**/HelarcHostRunComposition.test.ts", "forks"], ["**/HelarcMainController.test.ts", "forks"]],
  },
});
