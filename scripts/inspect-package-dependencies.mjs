import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPackageDependencyGraph,
  inspectPackageDependencies,
} from "./architecture/PackageDependencyGraph.mjs";
import { renderPackageInspection } from "./architecture/PackageDependencyReport.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const { packageName, includeDevelopment } = parseArguments(process.argv.slice(2));
  const graph = buildPackageDependencyGraph(repoRoot);
  const inspection = inspectPackageDependencies(graph, packageName, {
    includeDevelopment,
  });
  process.stdout.write(renderPackageInspection(inspection));
} catch (error) {
  console.error(`Package dependency inspection failed: ${error.message}`);
  process.exitCode = 1;
}

function parseArguments(args) {
  let packageName = null;
  let includeDevelopment = false;
  for (const argument of args) {
    if (argument === "--include-dev") {
      includeDevelopment = true;
    } else if (argument === "--help") {
      printHelp();
      process.exit(0);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument '${argument}'.`);
    } else if (packageName === null) {
      packageName = argument;
    } else {
      throw new Error(`Unexpected package argument '${argument}'.`);
    }
  }
  if (packageName === null) {
    throw new Error("A Workspace package name is required.");
  }
  return { packageName, includeDevelopment };
}

function printHelp() {
  console.log(`Usage: pnpm architecture:deps <package> [--include-dev]

Print direct and transitive dependencies and consumers for one Workspace package.`);
}
