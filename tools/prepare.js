/**
 * Fetch the three pinned sources and build `data/`, so a package installed from a
 * git URL or tarball is actually complete.
 *
 * WHY THIS EXISTS. `dsh plugin add github:owner/repo` goes through codeload, which
 * produces the moral equivalent of `git archive`: gitlinks (submodules) are present
 * as entries but their CONTENT is never included, and neither `.git` nor
 * `.gitmodules` is shipped. Measured on a real install of this repo:
 *
 *     data/                            False
 *     vendor/vrchat-world-codex-skills      missing (not even an empty dir)
 *     vendor/vrchat-editor-skill            missing
 *     VRChat-Agent-Creator-Library          missing
 *
 * `data/` is a build artifact and is gitignored, so it is absent too. The plugin
 * then throws on load (`assertDataPresent` checks seven artifacts), which means an
 * install that "succeeds" produces a plugin that cannot start.
 *
 * Running `git submodule update --init` here does NOT work: the installed tree has
 * no `.git` and no `.gitmodules` (verified: `fatal: not a git repository`). So the
 * three sources are pinned HERE, in this file, and cloned directly. Keeping the URLs
 * and commits next to the script is deliberate — reading `.gitmodules` would fail
 * precisely in the situation this script exists to handle.
 *
 * FAILURE IS FATAL BY DESIGN. A half-built package that installs successfully and
 * then refuses to load is worse than an install that fails loudly: the user sees a
 * plugin in the list, selects the preset, and gets nothing. Every step therefore
 * throws, and the build is verified against the same assertions the runtime uses
 * before this process exits 0.
 *
 * Requirements, all unavoidable: `git` on PATH, network access to GitHub, `node`.
 * An offline machine cannot install this package from a git URL — say so plainly
 * rather than shipping something broken.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
// isomorphic-git wants the whole `fs` namespace (`fs.promises.readFile` etc.), not
// the handful of named helpers imported above.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(ROOT, "..");

/**
 * Commit pins, keyed by submodule PATH.
 *
 * Only the pin lives here. Paths and URLs are read from `.gitmodules`, which is the
 * single source of truth for them — renaming a submodule or changing its URL is a
 * `.gitmodules` edit and needs no code change.
 *
 * The pin CANNOT come from `.gitmodules`: that file records path, url and a few
 * options, but not the checked-out commit. The commit is a gitlink in the tree
 * (mode 160000), and a codeload tarball carries no tree metadata to read it from.
 * So it stays pinned here, and a submodule with no pin is a hard error rather than
 * a silent "clone the default branch" — floating versions would make an installed
 * knowledge base differ between two machines.
 */
const PINS = {
  "VRChat-Agent-Creator-Library": "71485c2b5fb20f81c6fca6f96673d821c352c646",
  "vendor/vrchat-world-codex-skills": "08ef020dde293882edaf6d94834d2f44839fb307",
  "vendor/vrchat-editor-skill": "6aa07769b56ccb0a4450ba90bab53aaf3c287869",
};

/**
 * What must exist after each clone, so "successfully cloned nothing" is caught.
 * Keyed by path for the same reason as the pins.
 */
const EXPECT = {
  "VRChat-Agent-Creator-Library": ["memoryV5.0.0/LLMWikiExample/LLMWikiPage"],
  "vendor/vrchat-world-codex-skills": ["SKILL.md"],
  "vendor/vrchat-editor-skill": ["SKILL.md"],
};

/**
 * Parse `.gitmodules`.
 *
 * Format is git-config: `[submodule "name"]` headers followed by `key = value`
 * lines, with `#`/`;` comments and optional quoting around the value. Only `path`
 * and `url` are read; anything else is ignored on purpose, so a new option added
 * upstream does not break the parse.
 *
 * @returns {{name: string, path: string, url: string}[]}
 * @throws when the file is absent — that is a packaging bug (`.gitmodules` must be
 *         in `files`), and guessing the sources instead would hide it.
 */
function parseGitmodules(file) {
  if (!existsSync(file)) {
    throw new Error(
      `找不到 ${file}。它是三个上游仓库的权威来源，必须随包分发（package.json 的 files 白名单里要有它）。`,
    );
  }
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const out = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;

    const header = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (header !== null) {
      current = { name: header[1], path: null, url: null };
      out.push(current);
      continue;
    }
    if (current === null) continue;

    const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/);
    if (kv === null) continue;
    // Values may be quoted; strip a matching pair.
    let value = kv[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (kv[1] === "path") current.path = value;
    else if (kv[1] === "url") current.url = value;
  }

  const usable = out.filter((entry) => typeof entry.path === "string" && typeof entry.url === "string");
  if (usable.length === 0) {
    throw new Error(`${file} 里没有解析出任何 submodule（path + url）。`);
  }
  return usable;
}

/**
 * Combine `.gitmodules` (path + url) with the pin table (commit + expected contents).
 * @throws listing every problem at once, so one run tells you everything to fix.
 */
function resolveSources() {
  const declared = parseGitmodules(join(PKG_ROOT, ".gitmodules"));
  const problems = [];
  const sources = [];

  for (const entry of declared) {
    const commit = PINS[entry.path];
    if (commit === undefined) {
      problems.push(`  · ${entry.path} 在 .gitmodules 里，但 PINS 没有它的 commit 钉点`);
      continue;
    }
    const expect = EXPECT[entry.path];
    if (expect === undefined) {
      problems.push(`  · ${entry.path} 在 .gitmodules 里，但 EXPECT 没有它的产物检查项`);
      continue;
    }
    sources.push({ path: entry.path, url: entry.url, commit, expect });
  }

  // A pin with no submodule is dead weight and usually means a rename went half-done.
  for (const path of Object.keys(PINS)) {
    if (!declared.some((entry) => entry.path === path)) {
      problems.push(`  · PINS 里的 ${path} 在 .gitmodules 里没有对应项（改名了？还是删了？）`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`.gitmodules 与 prepare 的钉点表不一致：\n${problems.join("\n")}`);
  }
  return sources;
}

/** `data/` artifacts the plugin asserts on at load. */
const DATA_ARTIFACTS = [
  "index.json",
  "manifest.json",
  "t0-core.txt",
  "always-load.txt",
  "domain-map.txt",
  "api-table.json",
  "keyword-routes.json",
];

/**
 * Run a child process with NO shell.
 *
 * Two separate reasons, and they must not be conflated:
 *
 * 1. THE RUNTIME COMES FROM THE HOST, NOT FROM PATH. The build step runs
 *    `process.execPath` — the node that is executing this script right now, i.e.
 *    DSH's embedded node. Writing `node tools/build-knowledge.mjs` would instead
 *    resolve through PATH, where on a user's machine the answer is a SYSTEM node
 *    that may be absent or a much older major version. The plugin's own runtime
 *    APIs (and so what the build assumes) come from the embedded one. On this
 *    development machine PATH happens to start with a DSH wrapper, which is exactly
 *    the kind of local luck that hides this bug until a real user hits it.
 *
 * 2. `shell: true` re-parses the command line, and a path with a space dies there.
 *    That is not hypothetical — the first end-to-end install failed with
 *    `'D:\Program' is not recognized as an internal or external command` because
 *    `process.execPath` is `D:\Program Files\DSH Desktop\...\node.exe`. Without a
 *    shell, Node quotes each argument itself and such paths are safe.
 *
 * `git`, by contrast, has no such anchor: it is genuinely whatever the user
 * installed, so it is resolved once to an absolute path (see `resolveGit`) and then
 * invoked the same shell-free way.
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // No shell: arguments are passed verbatim, so spaces in paths are safe.
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`${command} 无法启动：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-6).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status})${detail ? `\n${detail}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * `git` as a bare name needs a shell or an absolute path on Windows. Resolve it
 * once, preferring PATH, then the standard install locations, so the rest of this
 * file can call it without a shell.
 */
let GIT_BIN = null;
function resolveGit() {
  if (GIT_BIN !== null) return GIT_BIN;
  const candidates = ["git"];
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? "";
    candidates.push(
      join(pf, "Git", "cmd", "git.exe"),
      join(pf86, "Git", "cmd", "git.exe"),
      join(local, "Programs", "Git", "cmd", "git.exe"),
    );
  }
  for (const candidate of candidates) {
    try {
      const out = spawnSync(candidate, ["--version"], { encoding: "utf8", shell: false });
      if (out.status === 0) {
        GIT_BIN = candidate;
        return candidate;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function hasGit() {
  return resolveGit() !== null;
}

function isPopulated(dir, expect) {
  if (!existsSync(dir)) return false;
  for (const rel of expect) {
    if (!existsSync(join(dir, ...rel.split("/")))) return false;
  }
  return true;
}

/**
 * Clone one pinned source into a temp sibling and move it into place.
 *
 * Cloning into a temp path and renaming afterwards means an interrupted run leaves
 * the destination untouched: readers see either the previous state or the complete
 * one, never a half-filled directory.
 *
 * TWO BACKENDS, and the order matters:
 *
 *   · system `git` when it exists — fastest, and it is what the user will use later
 *     for real work anyway;
 *   · `isomorphic-git` (pure JS) otherwise.
 *
 * The fallback is not a nicety. Installation is a PERFECT dependency cycle without
 * it: `prepare` must clone three repos, cloning needs git, and the guidance that
 * would let the agent install git lives in this plugin's persona — which only
 * exists after the install has already succeeded. A user with no git therefore
 * could not install at all. Pure-JS cloning breaks the cycle: installing needs no
 * external binary, and system git becomes a convenience rather than a prerequisite.
 *
 * Verified against the real API before wiring in: clone(depth/singleBranch/noTags)
 * → fetch(ref: <sha>, depth: 1) → checkout(ref: <sha>) lands the exact pinned commit
 * with the expected files, using no system git (1.7s for the smallest source).
 */
async function fetchSource(source) {
  const dest = join(PKG_ROOT, ...source.path.split("/"));
  if (isPopulated(dest, source.expect)) {
    console.log(`[prepare] ${source.path}: already present`);
    return false;
  }

  // A stale directory (empty gitlink leftover, or a broken earlier attempt) would
  // make the clone refuse, so clear it before cloning.
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });

  const tmp = `${dest}.prepare-tmp-${Date.now()}`;
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });

  const gitBin = resolveGit();
  if (gitBin !== null) {
    console.log(`[prepare] ${source.path}: cloning via system git`);
    cloneWithGit(gitBin, source, tmp);
  } else {
    console.log(`[prepare] ${source.path}: cloning via isomorphic-git (no system git)`);
    await cloneWithIsomorphicGit(source, tmp);
  }

  // Drop the inner git dir: this is vendored content, not a repository. Leaving it
  // would make the package look like a repo and can confuse later tooling.
  const innerGit = join(tmp, ".git");
  if (existsSync(innerGit)) rmSync(innerGit, { recursive: true, force: true });

  if (!isPopulated(tmp, source.expect)) {
    throw new Error(
      `${source.path}: cloned but ${source.expect.join(", ")} is missing — the pinned commit is wrong or the source changed layout`,
    );
  }

  renameSync(tmp, dest);
  console.log(`[prepare] ${source.path}: ready at ${source.commit.slice(0, 12)}`);
  return true;
}

/** System-git backend: shallow clone, then fetch and check out the exact pin. */
function cloneWithGit(gitBin, source, tmp) {
  run(gitBin, ["clone", "--depth", "1", source.url, tmp], PKG_ROOT);

  // The pinned commit may be older than HEAD, so deepen until it is reachable.
  // `--depth 1` alone would fail for any commit that is not the branch tip.
  try {
    run(gitBin, ["-C", tmp, "fetch", "--depth", "1", "origin", source.commit], PKG_ROOT);
  } catch {
    // Fall back to a full fetch: shallow fetch of a specific SHA is not supported
    // by every server configuration.
    run(gitBin, ["-C", tmp, "fetch", "--unshallow"], PKG_ROOT);
  }
  run(gitBin, ["-C", tmp, "checkout", source.commit], PKG_ROOT);
}

/**
 * Pure-JS backend. Same sequence as the git backend, expressed through
 * isomorphic-git so no external binary is required.
 *
 * Loaded lazily: if system git handled every source, this module is never imported,
 * which keeps the common path free of ~55 extra modules.
 */
async function cloneWithIsomorphicGit(source, tmp) {
  const git = await import("isomorphic-git");
  const http = (await import("isomorphic-git/http/node")).default;

  await git.clone({
    fs,
    http,
    dir: tmp,
    url: source.url,
    depth: 1,
    singleBranch: true,
    noTags: true,
  });

  try {
    // As with system git: ask for the specific commit shallowly, then widen if the
    // server refuses. `depth: 1` from the branch tip rarely contains an older SHA.
    await git.fetch({
      fs,
      http,
      dir: tmp,
      url: source.url,
      ref: source.commit,
      depth: 1,
      singleBranch: true,
    });
  } catch {
    await git.fetch({ fs, http, dir: tmp, url: source.url });
  }

  // Verify the checkout landed on the pin rather than merely "some commit".
  await git.checkout({ fs, dir: tmp, ref: source.commit, force: true });
  const head = await git.resolveRef({ fs, dir: tmp, ref: "HEAD" });
  if (head !== source.commit) {
    throw new Error(
      `${source.path}: checked out ${head.slice(0, 12)} but the pin is ${source.commit.slice(0, 12)}`,
    );
  }
}

function buildData() {
  const manifestPath = join(PKG_ROOT, "data", "manifest.json");
  const allThere = DATA_ARTIFACTS.every((rel) => existsSync(join(PKG_ROOT, "data", rel)));

  // Rebuild only when an artifact is missing. `npm install` runs again on every
  // dependency change; rebuilding a complete tree each time would be wasted work
  // and would make install latency worse for no gain.
  if (allThere) {
    console.log("[prepare] data/: already complete");
    return false;
  }

  console.log("[prepare] data/: building from the corpus");
  run(process.execPath, [join(ROOT, "build-knowledge.mjs")], PKG_ROOT);

  const missing = DATA_ARTIFACTS.filter((rel) => !existsSync(join(PKG_ROOT, "data", rel)));
  if (missing.length > 0) {
    throw new Error(`build-knowledge produced an incomplete data/: missing ${missing.join(", ")}`);
  }
  return true;
}

async function main() {
  // No git is no longer fatal — the pure-JS backend handles that case. What is
  // fatal is having NEITHER, which cannot happen: isomorphic-git ships as a
  // dependency. The message below only fires if the dependency itself is missing.
  const gitBin = resolveGit();
  if (gitBin === null) {
    console.log(
      "[prepare] 系统里没有 git —— 改用 isomorphic-git（纯 JS）克隆，安装照常进行。",
    );
  }

  // Resolve the source list BEFORE touching the network: a mismatch between
  // `.gitmodules` and the pin table is a packaging bug, and failing fast here beats
  // cloning two repos and then discovering the third has no pin.
  const sources = resolveSources();
  console.log(
    `[prepare] .gitmodules 声明了 ${sources.length} 个上游仓库：${sources.map((s) => s.path).join(", ")}`,
  );

  let fetched = 0;
  for (const source of sources) {
    if (await fetchSource(source)) fetched++;
  }

  const built = buildData();

  console.log(
    `[prepare] done: ${fetched} source(s) cloned, data/ ${built ? "built" : "already present"}`,
  );
}

// `main` is async now (the pure-JS backend is promise-based), so the catch has to
// hang off the promise rather than a bare try/catch around the call.
main().catch((error) => {
  console.error("\n[prepare] 安装中止 —— 这个包现在不可用。");
  console.error(`[prepare] 原因：${error?.message ?? error}\n`);
  console.error(
    "[prepare] 这是一个「装不上」而不是「装上了但坏」的失败：缺语料时插件一加载就会报错，" +
      "让你先看到失败比事后在会话里遇到更好。\n",
  );
  process.exit(1);
});
