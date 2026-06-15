import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoots = [
  "packages/shared",
  "packages/tools",
  "packages/evidence",
  "packages/permission",
  "packages/governance",
  "packages/observability",
  "packages/providers",
  "packages/storage",
  "packages/agent-core",
  "packages/extensions",
  "packages/testing",
  "products/net-doctor",
  "apps/net-doctor-cli",
  "apps/net-doctor-desktop",
].map((item) => resolve(repoRoot, item));

const packageInfo = new Map();
const packageByName = new Map();
for (const root of packageRoots) {
  const packageJson = readJson(join(root, "package.json"));
  const info = {
    root,
    name: packageJson.name,
    exports: exportedSpecifiers(packageJson),
    dependencies: new Set(Object.keys(packageJson.dependencies ?? {})),
    devDependencies: new Set(Object.keys(packageJson.devDependencies ?? {})),
  };
  packageInfo.set(root, info);
  packageByName.set(info.name, info);
}

const violations = [];
for (const root of packageRoots) {
  for (const file of collectSourceFiles(root)) {
    checkFile(file);
  }
}
checkPackageExports();

if (violations.length > 0) {
  console.error("Boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Boundary check passed.");

function checkFile(file) {
  const owner = owningPackage(file);
  if (!owner) {
    return;
  }

  const text = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const isTestOnly = isTestFile(file) || normalized(file).includes("/src/testing/");

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }

    const specifier = moduleSpecifier.text;
    if (specifier.startsWith("@agent-anything/")) {
      checkWorkspaceImport({
        file,
        owner,
        imported: parseWorkspaceSpecifier(specifier),
        isTestOnly,
      });
    } else if (specifier.startsWith(".")) {
      checkRelativeImport(file, owner, specifier);
    }
  }
}

function checkWorkspaceImport({ file, owner, imported, isTestOnly }) {
  const rel = display(file);

  if (imported.packageName === "@agent-anything/platform") {
    violations.push(`${rel} must consume concrete platform packages, not @agent-anything/platform.`);
    return;
  }

  const importedPackage = packageByName.get(imported.packageName);
  if (!importedPackage) {
    return;
  }

  if (!importedPackage.exports.has(imported.exportKey)) {
    violations.push(`${rel} imports non-public package path '${imported.raw}'.`);
  }

  const hasDependency = owner.dependencies.has(imported.packageName);
  const hasDevDependency = owner.devDependencies.has(imported.packageName);
  const isSelf = owner.name === imported.packageName;
  if (!isSelf && !hasDependency && !(isTestOnly && hasDevDependency)) {
    violations.push(`${rel} imports '${imported.packageName}' without declaring it in ${isTestOnly ? "dependencies or devDependencies" : "dependencies"}.`);
  }
  if (!isSelf && !isTestOnly && !hasDependency) {
    violations.push(`${rel} production import '${imported.packageName}' must be declared in dependencies, not only devDependencies.`);
  }

  if (!isTestOnly && imported.packageName === "@agent-anything/testing") {
    violations.push(`${rel} production code must not import @agent-anything/testing.`);
  }

  if (!isTestOnly) {
    checkLayerRule(file, owner.name, imported.packageName);
  }
}

function checkLayerRule(file, ownerName, importedName) {
  const rel = display(file);
  const lowerLayerPackages = new Set([
    "@agent-anything/shared",
    "@agent-anything/tools",
    "@agent-anything/evidence",
    "@agent-anything/permission",
    "@agent-anything/governance",
    "@agent-anything/observability",
    "@agent-anything/providers",
    "@agent-anything/storage",
  ]);

  if (ownerName === "@agent-anything/shared" && importedName !== "@agent-anything/shared") {
    violations.push(`${rel} shared package must not import '${importedName}'.`);
  }

  if (lowerLayerPackages.has(ownerName)) {
    for (const forbidden of [
      "@agent-anything/agent-core",
      "@agent-anything/extensions",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} layer 1 package must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/agent-core") {
    for (const forbidden of [
      "@agent-anything/extensions",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} agent-core production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/extensions") {
    for (const forbidden of [
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} extensions production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/testing") {
    for (const forbidden of [
      "@agent-anything/agent-core",
      "@agent-anything/extensions",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} testing package must not import '${forbidden}' to avoid package cycles.`);
      }
    }
  }
}

function checkRelativeImport(file, owner, specifier) {
  const resolved = resolve(dirname(file), specifier);
  const ownerRoot = `${owner.root}${sep}`;
  if (resolved !== owner.root && !resolved.startsWith(ownerRoot)) {
    violations.push(`${display(file)} uses a relative import that crosses package boundary: '${specifier}'.`);
  }
}

function checkPackageExports() {
  for (const info of packageInfo.values()) {
    const packageJson = readJson(join(info.root, "package.json"));
    for (const [exportKey, exportValue] of Object.entries(packageJson.exports ?? {})) {
      if (typeof exportValue !== "object" || exportValue === null || !("types" in exportValue)) {
        violations.push(`${display(join(info.root, "package.json"))} export '${exportKey}' must declare a types entry.`);
        continue;
      }

      const typesPath = resolve(info.root, exportValue.types);
      if (!exists(typesPath)) {
        violations.push(`${display(join(info.root, "package.json"))} export '${exportKey}' points to missing types file '${exportValue.types}'.`);
      }
    }
  }
}

function parseWorkspaceSpecifier(raw) {
  const parts = raw.split("/");
  const packageName = `${parts[0]}/${parts[1]}`;
  const exportKey = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
  return { raw, packageName, exportKey };
}

function exportedSpecifiers(packageJson) {
  const exports = packageJson.exports ?? {};
  if (typeof exports === "string") {
    return new Set(["."]);
  }
  return new Set(Object.keys(exports));
}

function collectSourceFiles(root) {
  const result = [];
  walk(root, result);
  return result;
}

function walk(dir, result) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }

    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, result);
    } else if (/\.(c|m)?tsx?$/.test(entry)) {
      result.push(fullPath);
    }
  }
}

function owningPackage(file) {
  const normalizedFile = `${resolve(file)}${sep}`;
  return [...packageInfo.values()]
    .filter((info) => normalizedFile.startsWith(`${info.root}${sep}`))
    .sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}

function isTestFile(file) {
  return /\.(test|spec)\.(c|m)?tsx?$/.test(file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

function display(file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}

function normalized(file) {
  return resolve(file).replaceAll("\\", "/");
}
