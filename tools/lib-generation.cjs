/**
 * Pick the newest installed generation of a package.
 *
 * MUST sort by modification time, not by name: generation names embed a version
 * (`dsh-vrchat-kb+0.11.0+hash`), and string sorting puts `0.9.0` AFTER `0.11.0`.
 * A name-sorted pick therefore silently verified a stale generation while
 * reporting success — the failure mode this helper exists to remove.
 *
 * Usage:
 *   const { newestGeneration } = require("./lib-generation.cjs");
 *   const target = newestGeneration("dsh-vrchat-kb+");
 */

const fs = require("node:fs");
const path = require("node:path");

/** Directory holding every installed generation of every bundle. */
function liveRoot() {
  const home =
    process.env.DSH_HOME ?? path.join(process.env.APPDATA ?? "", "dsh-desktop", "harness");
  return path.join(home, "profiles", ".generations", "live");
}

/**
 * Newest installed generation whose name starts with `prefix`.
 * @param prefix - e.g. `"dsh-vrchat-kb+"`.
 * @returns the generation directory name, or null when none is installed.
 */
function newestGeneration(prefix) {
  const root = liveRoot();
  if (!fs.existsSync(root)) return null;
  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => ({
      name: entry.name,
      mtime: fs.statSync(path.join(root, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length === 0 ? null : candidates[0].name;
}

/** Absolute path of the newest generation's package directory. */
function newestPackageDir(prefix, packageName) {
  const generation = newestGeneration(prefix);
  if (generation === null) return null;
  return path.join(liveRoot(), generation, "node_modules", packageName);
}

module.exports = { liveRoot, newestGeneration, newestPackageDir };
