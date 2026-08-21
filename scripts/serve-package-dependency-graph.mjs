import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPackageDependencyServer } from "./architecture/PackageDependencyServer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseArguments(process.argv.slice(2));
  const service = await startPackageDependencyServer({
    repoRoot,
    port: options.port,
    defaultFilters: options.filters,
  });
  console.log(`Package Dependency Explorer is available at ${service.url}`);
  console.log(`JSON: ${service.baseUrl}/package-dependencies.json`);
  console.log(`Mermaid: ${service.baseUrl}/package-dependencies.mmd`);
  console.log("Press Ctrl+C to stop the service.");
  if (options.open) openDefaultBrowser(service.url);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  console.error(`Package Dependency Explorer failed to start: ${error.message}`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const options = {
    port: 4310,
    open: false,
    filters: {
      scope: null,
      focus: null,
      depth: null,
      reverse: false,
      includeDevelopment: false,
    },
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const port = Number(requireValue(args, ++index, argument));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer from 1 through 65535.");
      }
      options.port = port;
    } else if (argument === "--scope") {
      options.filters.scope = requireValue(args, ++index, argument);
    } else if (argument === "--focus") {
      options.filters.focus = requireValue(args, ++index, argument);
    } else if (argument === "--depth") {
      const depth = Number(requireValue(args, ++index, argument));
      if (!Number.isInteger(depth) || depth < 0) {
        throw new Error("--depth must be a non-negative integer.");
      }
      options.filters.depth = depth;
    } else if (argument === "--reverse") {
      options.filters.reverse = true;
    } else if (argument === "--include-dev") {
      options.filters.includeDevelopment = true;
    } else if (argument === "--open") {
      options.open = true;
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

function openDefaultBrowser(url) {
  const command = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(`Could not open the default browser: ${error.message}`);
  });
  child.unref();
}

function printHelp() {
  console.log(`Usage: pnpm architecture:graph:serve -- [options]

Options:
  --port <number>       Listen on a stable loopback port. Default: 4310.
  --scope <scope>       Open with one repository kind, Product, or component group.
  --focus <package>     Open focused on one Workspace package.
  --depth <number>      Limit traversal depth when --focus is present.
  --reverse             Follow consumers instead of dependencies.
  --include-dev         Include development and test dependencies.
  --open                Open the initial view in the default browser.
  --help                Show this help.`);
}
