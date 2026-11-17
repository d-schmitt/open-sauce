import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { InputError } from "./model.mjs";
import { writeFileAtomic } from "./fsutil.mjs";

export const APP_DIR = dirname(fileURLToPath(import.meta.url));
export const DEMO_SOURCE = join(APP_DIR, "examples", "demo-cookbook");

export function configPath(env = process.env) {
  return env.OPEN_SAUCE_CONFIG || join(homedir(), ".config", "open-sauce", "config.json");
}

/** Real data never defaults to a location: it comes from OPEN_SAUCE_DATA or the user config file. */
export function resolveDataDir(env = process.env) {
  if (env.OPEN_SAUCE_DATA) return { dir: resolve(env.OPEN_SAUCE_DATA), source: "env" };
  try {
    const config = JSON.parse(readFileSync(configPath(env), "utf8"));
    if (typeof config.dataDir === "string" && isAbsolute(config.dataDir)) return { dir: config.dataDir, source: "config" };
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`The config file ${configPath(env)} could not be read: ${error.message}`);
  }
  return null;
}

function forbiddenRoots() {
  const roots = [APP_DIR];
  const project = resolve(APP_DIR, "..", "..", "..");
  if (basename(resolve(APP_DIR, "..", "..")) === ".github") roots.push(project);
  return roots;
}

export function checkDataDir(dir) {
  if (typeof dir !== "string" || !isAbsolute(dir.trim())) throw new InputError("Enter an absolute folder path, for example /Users/you/Documents/cookbook.");
  dir = resolve(dir.trim());
  for (const root of forbiddenRoots()) {
    const rel = relative(root, dir);
    if (!rel.startsWith("..") && !isAbsolute(rel)) throw new InputError("Keep your cookbook outside the app folder, so app updates never touch your recipes.");
  }
  return dir;
}

export function saveConfig(dataDir, env = process.env) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ dataDir }, null, 2)}\n`);
}
