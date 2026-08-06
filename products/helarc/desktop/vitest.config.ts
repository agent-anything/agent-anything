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
      "@agent-anything/helarc/configuration": resolve(currentDir, "../product/src/configuration/index.ts"),
      "@agent-anything/helarc/work-context": resolve(currentDir, "../product/src/work-context/index.ts"),
      "@agent-anything/helarc/run": resolve(currentDir, "../product/src/run/index.ts"),
      "@agent-anything/helarc/composition": resolve(currentDir, "../product/src/composition/index.ts"),
      "@agent-anything/helarc": resolve(currentDir, "../product/src/index.ts"),
      "@agent-anything/helarc-code-agent/task": resolve(currentDir, "../code-agent/src/task/index.ts"),
      "@agent-anything/helarc-code-agent/controller": resolve(currentDir, "../code-agent/src/controller/index.ts"),
      "@agent-anything/helarc-code-agent/prompt": resolve(currentDir, "../code-agent/src/prompt/index.ts"),
      "@agent-anything/helarc-code-agent/tools": resolve(currentDir, "../code-agent/src/tools/index.ts"),
      "@agent-anything/helarc-code-agent/task-templates": resolve(currentDir, "../code-agent/src/task-templates/index.ts"),
      "@agent-anything/helarc-code-agent/workspace": resolve(currentDir, "../code-agent/src/workspace/index.ts"),
      "@agent-anything/helarc-code-agent/filesystem": resolve(currentDir, "../code-agent/src/filesystem/index.ts"),
      "@agent-anything/helarc-code-agent/file-actions": resolve(currentDir, "../code-agent/src/file-actions/index.ts"),
      "@agent-anything/helarc-code-agent/command": resolve(currentDir, "../code-agent/src/command/index.ts"),
      "@agent-anything/helarc-code-agent/patch": resolve(currentDir, "../code-agent/src/patch/index.ts"),
      "@agent-anything/helarc-code-agent/observability": resolve(currentDir, "../code-agent/src/observability/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
