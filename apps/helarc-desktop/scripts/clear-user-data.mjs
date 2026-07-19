import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(scriptDirectory, "../package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const productName = readProductName(packageJson);
const appDataPath = resolveElectronAppDataPath(process.platform, process.env, homedir());
const userDataPath = resolve(appDataPath, productName);

assertSafeUserDataPath(userDataPath, appDataPath, productName);

if (process.argv.includes("--dry-run")) {
  console.log(`Would delete Helarc user data: ${userDataPath}`);
} else {
  await rm(userDataPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  console.log(`Deleted Helarc user data: ${userDataPath}`);
}

function readProductName(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Helarc Desktop package.json must contain an object.");
  }
  const productName = value.productName;
  if (typeof productName !== "string" || productName.trim().length === 0) {
    throw new TypeError("Helarc Desktop productName is required.");
  }
  return productName.trim();
}

function resolveElectronAppDataPath(platform, env, homeDirectory) {
  if (platform === "win32") {
    return resolve(readOptionalPath(env.APPDATA) ?? join(homeDirectory, "AppData", "Roaming"));
  }
  if (platform === "darwin") {
    return resolve(homeDirectory, "Library", "Application Support");
  }
  return resolve(readOptionalPath(env.XDG_CONFIG_HOME) ?? join(homeDirectory, ".config"));
}

function readOptionalPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertSafeUserDataPath(userDataPath, appDataPath, productName) {
  if (productName === "." || productName === ".." || basename(productName) !== productName) {
    throw new TypeError("Helarc Desktop productName cannot contain a path.");
  }
  if (dirname(userDataPath) !== resolve(appDataPath) || basename(userDataPath) !== productName) {
    throw new TypeError("Refusing to delete a path outside the Electron app-data directory.");
  }
}
