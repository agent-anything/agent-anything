import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: currentDir,
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@agent-anything/helarc": resolve(currentDir, "../../products/helarc/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
