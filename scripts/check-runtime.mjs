import { readFileSync } from "node:fs";

const version = readFileSync(new URL("../.node-version", import.meta.url), "utf8")
  .trim()
  .replace(/^v/, "");
const EXPECTED_NODE_VERSION = `v${version}`;
const normalizedExecPath = process.execPath.replaceAll("\\", "/").toLowerCase();
const isFnmRuntime = normalizedExecPath.includes("/fnm/node-versions/");

if (process.version !== EXPECTED_NODE_VERSION || !isFnmRuntime) {
  console.error(
    [
      "Unsupported Node.js runtime.",
      `Expected: ${EXPECTED_NODE_VERSION} from FNM`,
      `Actual:   ${process.version} from ${process.execPath}`,
      "Run `fnm use` from the repository root and retry.",
      "The command was stopped before build or test execution.",
    ].join("\n"),
  );
  process.exit(1);
}
