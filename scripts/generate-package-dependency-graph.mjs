import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPackageDependencyGraph,
  selectPackageDependencyGraph,
} from "./architecture/PackageDependencyGraph.mjs";
import {
  renderPackageDependencyHtml,
  renderPackageDependencyJson,
  renderPackageDependencyMermaid,
} from "./architecture/PackageDependencyReport.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseArguments(process.argv.slice(2));
  const graph = selectPackageDependencyGraph(
    buildPackageDependencyGraph(repoRoot),
    options,
  );
  const outputDirectory = resolve(repoRoot, options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });

  const reports = [
    ["package-dependencies.json", renderPackageDependencyJson(graph)],
    ["package-dependencies.mmd", renderPackageDependencyMermaid(graph)],
    ["package-dependencies.html", renderPackageDependencyHtml(graph)],
  ];
  for (const [name, content] of reports) {
    writeFileSync(resolve(outputDirectory, name), content, "utf8");
  }

  console.log(
    `Generated ${graph.nodes.length} packages and ${graph.edges.length} dependencies in ${outputDirectory}.`,
  );
  for (const [name] of reports) console.log(`- ${resolve(outputDirectory, name)}`);
  if (graph.issues.length > 0) {
    console.warn(`Dependency graph contains ${graph.issues.length} issue(s):`);
    for (const issue of graph.issues) console.warn(`- [${issue.code}] ${issue.message}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Package dependency graph generation failed: ${error.message}`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const options = {
    scope: null,
    focus: null,
    depth: null,
    reverse: false,
    includeDevelopment: false,
    outputDirectory: ".artifacts/architecture",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--scope") {
      options.scope = requireValue(args, ++index, argument);
    } else if (argument === "--focus") {
      options.focus = requireValue(args, ++index, argument);
    } else if (argument === "--depth") {
      const rawDepth = requireValue(args, ++index, argument);
      options.depth = Number(rawDepth);
    } else if (argument === "--reverse") {
      options.reverse = true;
    } else if (argument === "--include-dev") {
      options.includeDevelopment = true;
    } else if (argument === "--out-dir") {
      options.outputDirectory = requireValue(args, ++index, argument);
    } else if (argument === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument '${argument}'.`);
    }
  }
  return options;
}

function requireValue(args, index, argument) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${argument} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: pnpm architecture:graph -- [options]

Options:
  --scope <scope>       Keep one repository kind, Product, or component group.
  --focus <package>     Follow dependencies from one Workspace package.
  --depth <number>      Limit traversal depth when --focus is present.
  --reverse             Follow consumers instead of dependencies.
  --include-dev         Include development and test dependencies.
  --out-dir <path>      Change the output directory.
  --help                Show this help.`);
}
