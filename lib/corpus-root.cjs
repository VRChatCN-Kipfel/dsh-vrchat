/**
 * Resolve where the upstream corpus sits inside this package.
 *
 * WHY A RESOLVER AND NOT A CONSTANT. The corpus root used to be spelled out as a
 * literal segment list — once in the retrieval layer and again in sixteen
 * build/check scripts. Upstream renames its knowledge root on every minor release
 * (`memoryV5.0.0` → `memoryV5.0.2` → `memoryV5.0.3`), so a submodule bump that
 * moved only the gitlink left every one of those literals pointing at a directory
 * that no longer existed: the package installed "successfully" and then answered
 * 「知识库语料不可用」. One resolver is now the single place that knows the shape.
 *
 * STILL DECLARED, NOT DISCOVERED. The first segment is hardcoded on purpose. A
 * library that scans its package for "something that looks like a corpus" can
 * pick up a sibling library's pages, which is exactly the cross-contamination
 * multi-library support exists to prevent. Only the VERSION segment is matched,
 * and only inside this library's own submodule directory.
 *
 * NEWEST WINS, NO SILENT FALLBACK. When several `memoryV*` directories are
 * present (a stale checkout left beside a fresh one), the highest version is the
 * only candidate tried. Falling back to an older directory would make a broken
 * checkout look healthy and would quietly serve last release's pages — the
 * caller is better served by a null it can report than by a plausible directory
 * it cannot verify.
 *
 * CommonJS on purpose: `lib/` is ESM and `tools/*.cjs` are CommonJS, so the one
 * implementation has to be loadable from both. ESM callers use
 * `createRequire` or the CJS default import; nothing here imports anything else.
 */
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

/**
 * This library's declared position for the corpus.
 *
 * `*` marks a version segment: any DIRECTORY entry in that position whose name
 * starts with the prefix before the star is a candidate. The rest are literal.
 */
const CORPUS_ENTRY = ["VRChat-Agent-Creator-Library", "memoryV5.*", "LLMWikiExample", "LLMWikiPage"];

/** Knowledge-root naming scheme upstream uses, captured for numeric ordering. */
const VERSION_SEGMENT = /^memoryV(\d+(?:\.\d+)*)$/;

/**
 * Numeric parts of a knowledge-root name, or null when it is not one.
 *
 * @param {string} name - a directory name such as `memoryV5.0.3`.
 * @returns {number[] | null}
 */
function versionParts(name) {
  const match = VERSION_SEGMENT.exec(name);
  if (match === null) return null;
  return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Descending numeric comparison, so `memoryV5.0.10` sorts above `memoryV5.0.9`
 * (string ordering gets that backwards).
 *
 * Missing trailing parts count as 0, so `memoryV5.0` and `memoryV5.0.0` tie
 * instead of one of them winning arbitrarily.
 */
function compareVersions(left, right) {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return b - a;
  }
  return 0;
}

/**
 * Knowledge-root directory names under `dir`, newest first.
 *
 * Unreadable or missing directories yield an empty list: "not here" is a normal
 * answer for a package whose submodule has not been checked out yet.
 *
 * @param {string} dir - usually `.../VRChat-Agent-Creator-Library`.
 * @returns {string[]} directory names, highest version first.
 */
function listVersionDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && VERSION_SEGMENT.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareVersions(versionParts(left), versionParts(right)));
}

/**
 * Walk `entry` from `packageRoot`, expanding version segments to the newest
 * matching directory.
 *
 * @returns {{path: string, segments: string[]} | null} null as soon as a segment
 *          names nothing: a partial answer would be a path that does not exist.
 */
function walkEntry(packageRoot, entry) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0) return null;
  const segments = [];
  let cursor = packageRoot;
  for (const segment of entry) {
    if (typeof segment !== "string" || segment.length === 0) return null;
    const star = segment.indexOf("*");
    let name = segment;
    if (star !== -1) {
      const prefix = segment.slice(0, star);
      name = listVersionDirs(cursor).find((candidate) => candidate.startsWith(prefix));
      if (name === undefined) return null;
    }
    cursor = join(cursor, name);
    segments.push(name);
  }
  return { path: cursor, segments };
}

/**
 * Is `candidate` a corpus rather than an empty directory git created before
 * fetching? Recognized by its domain tree, so a half-checked-out submodule reads
 * as "not here" instead of "a corpus with zero pages".
 */
function isCorpus(candidate) {
  try {
    return existsSync(join(candidate, "entities")) || existsSync(join(candidate, "index.md"));
  } catch {
    return false;
  }
}

/**
 * Absolute corpus path beneath `packageRoot`, or null when it is not there.
 *
 * @param {string} packageRoot - the installed package directory.
 * @param {string[]} [entry] - layout to resolve; a sibling library passes its own.
 */
function resolveCorpusRoot(packageRoot, entry = CORPUS_ENTRY) {
  const walked = walkEntry(packageRoot, entry);
  if (walked === null || !isCorpus(walked.path)) return null;
  return walked.path;
}

/**
 * The layout actually resolved, with the version segment spelled out.
 *
 * Callers that need to NAME the directory — manifests, and checks that assert a
 * literal path is rejected — use this instead of hardcoding a version.
 *
 * @returns {string[] | null} e.g. `["VRChat-Agent-Creator-Library", "memoryV5.0.3", …]`
 */
function corpusEntrySegments(packageRoot, entry = CORPUS_ENTRY) {
  const walked = walkEntry(packageRoot, entry);
  if (walked === null || !isCorpus(walked.path)) return null;
  return walked.segments;
}

/**
 * Same as `resolveCorpusRoot`, but throws instead of returning null.
 *
 * Build and check scripts must not continue with a null path: the failure then
 * surfaces as a `readdir` TypeError several frames later instead of as "the
 * corpus is not where the layout says", which is the actionable fact.
 */
function requireCorpusRoot(packageRoot, entry = CORPUS_ENTRY) {
  const resolved = resolveCorpusRoot(packageRoot, entry);
  if (resolved !== null) return resolved;
  const base = entry[0] ?? "";
  const seen = typeof base === "string" && base.length > 0 && !base.includes("*")
    ? listVersionDirs(join(String(packageRoot), base))
    : [];
  throw new Error(
    [
      "找不到知识库语料。",
      `  包根：${packageRoot}`,
      `  声明布局：${entry.join("/")}`,
      `  ${base} 下的版本目录：${seen.length === 0 ? "（没有 memoryV* 目录）" : seen.join(", ")}`,
      "  多半是子模块没检出（git submodule update --init），或上游又改了知识根目录名。",
    ].join("\n"),
  );
}

module.exports = {
  CORPUS_ENTRY,
  VERSION_SEGMENT,
  versionParts,
  compareVersions,
  listVersionDirs,
  resolveCorpusRoot,
  requireCorpusRoot,
  corpusEntrySegments,
};
