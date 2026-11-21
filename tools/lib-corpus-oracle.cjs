/**
 * A SECOND OPINION on "which knowledge root is newest".
 *
 * `lib/corpus-root.cjs` is the implementation the plugin ships. Tests must not
 * ask an implementation to certify itself: `resolve(x) === resolve(x)` holds no
 * matter how wrong the rule is, and that is exactly the shape of assertion that
 * let a stale corpus path survive a submodule bump in the first place.
 *
 * So this file re-derives the answer from a plain directory listing through a
 * DIFFERENT mechanism — ICU numeric collation rather than hand-rolled version
 * tuples. When the shipped rule is wrong (lexicographic ordering, a fallback to
 * an older directory, a wildcard that escapes the submodule), the two disagree
 * and a check fails. When both agree, the assertion still means something.
 *
 * Test-only. Not shipped, not imported by the plugin.
 */
const { readdirSync } = require("node:fs");

/** Knowledge-root names, matching upstream's scheme. */
const NAME = /^memoryV\d+(?:\.\d+)*$/;

/**
 * Knowledge-root directory names under `dir`, newest first.
 *
 * Numeric collation is the point: `memoryV5.0.10` must outrank `memoryV5.0.9`,
 * which plain string ordering gets backwards.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function versionDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Newest knowledge-root directory name under `dir`, or null when there is none.
 *
 * @param {string} dir
 * @returns {string | null}
 */
function newestVersionDir(dir) {
  return versionDirs(dir)[0] ?? null;
}

module.exports = { versionDirs, newestVersionDir, NAME };
