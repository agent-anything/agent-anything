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
      "@agent-anything/helarc/configuration": resolve(currentDir, "../core/src/configuration/index.ts"),
      "@agent-anything/helarc/work-context": resolve(currentDir, "../core/src/work-context/index.ts"),
      "@agent-anything/helarc/run": resolve(currentDir, "../core/src/run/index.ts"),
      "@agent-anything/helarc/composition": resolve(currentDir, "../core/src/composition/index.ts"),
      "@agent-anything/helarc/task": resolve(currentDir, "../core/src/task/index.ts"),
      "@agent-anything/helarc/controller": resolve(currentDir, "../core/src/controller/index.ts"),
      "@agent-anything/helarc/interaction": resolve(currentDir, "../core/src/interaction/index.ts"),
      "@agent-anything/helarc/prompt": resolve(currentDir, "../core/src/prompt/index.ts"),
      "@agent-anything/helarc/tools": resolve(currentDir, "../core/src/tools/index.ts"),
      "@agent-anything/helarc/verification": resolve(currentDir, "../core/src/verification/index.ts"),
      "@agent-anything/helarc/model-qualification": resolve(currentDir, "../core/src/model-qualification/index.ts"),
      "@agent-anything/helarc": resolve(currentDir, "../core/src/index.ts"),
      "@agent-anything/helarc-code-agent/workspace": resolve(currentDir, "../code-agent/src/workspace/index.ts"),
      "@agent-anything/helarc-code-agent/source": resolve(currentDir, "../code-agent/src/source/index.ts"),
      "@agent-anything/helarc-code-agent/verification": resolve(currentDir, "../code-agent/src/verification/index.ts"),
      "@agent-anything/helarc-code-agent/file-operation": resolve(currentDir, "../code-agent/src/file-operation/index.ts"),
      "@agent-anything/helarc-local-environment/workspace": resolve(currentDir, "../local-environment/src/workspace/index.ts"),
      "@agent-anything/helarc-local-environment/filesystem": resolve(currentDir, "../local-environment/src/filesystem/index.ts"),
      "@agent-anything/helarc-local-environment/command": resolve(currentDir, "../local-environment/src/command/index.ts"),
      "@agent-anything/helarc-local-environment/sandbox": resolve(currentDir, "../local-environment/src/sandbox/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
