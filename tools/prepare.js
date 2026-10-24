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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(ROOT, "..");

/**
 * Pinned sources. The commit hashes match `.gitmodules`' recorded gitlinks at the
 * time of writing; change both together if you bump one.
 */
const SOURCES = [
  {
    path: "VRChat-Agent-Creator-Library",
    url: "https://github.com/RhineLab-magellan/VRChat-Agent-Creator-Library.git",
    commit: "590a9f90833a6fe98044c10aea4fb86ed4876fc9",
    // What must exist afterwards, so a "successful" clone of nothing is caught.
    expect: ["memoryV5.0.0/LLMWikiExample/LLMWikiPage"],
  },
  {
    path: "vendor/vrchat-world-codex-skills",
    url: "https://github.com/VRChatCN-Kipfel/vrchat-world-codex-skills.git",
    commit: "08ef020dde293882edaf6d94834d2f44839fb307",
    expect: ["SKILL.md"],
  },
  {
    path: "vendor/vrchat-editor-skill",
    url: "https://github.com/XiaoboooOvO/VRChatEditorSkill.git",
    commit: "6aa07769b56ccb0a4450ba90bab53aaf3c287869",
    expect: ["SKILL.md"],
  },
];

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
 */
function fetchSource(source) {
  const dest = join(PKG_ROOT, ...source.path.split("/"));
  if (isPopulated(dest, source.expect)) {
    console.log(`[prepare] ${source.path}: already present`);
    return false;
  }

  // A stale directory (empty gitlink leftover, or a broken earlier attempt) would
  // make `git clone` refuse, so clear it before cloning.
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });

  const tmp = `${dest}.prepare-tmp-${Date.now()}`;
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });

  console.log(`[prepare] ${source.path}: cloning ${source.url}`);
  run(GIT_BIN, ["clone", "--depth", "1", source.url, tmp], PKG_ROOT);

  // The pinned commit may be older than HEAD, so deepen until it is reachable.
  // `--depth 1` alone would fail for any commit that is not the branch tip.
  try {
    run(GIT_BIN, ["-C", tmp, "fetch", "--depth", "1", "origin", source.commit], PKG_ROOT);
  } catch {
    // Fall back to a full fetch: shallow fetch of a specific SHA is not supported
    // by every server configuration.
    run(GIT_BIN, ["-C", tmp, "fetch", "--unshallow"], PKG_ROOT).toString();
  }
  run(GIT_BIN, ["-C", tmp, "checkout", source.commit], PKG_ROOT);

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

function main() {
  if (!hasGit()) {
    throw new Error(
      "git 不在 PATH 上。本项目从 git URL 安装时需要克隆三个上游仓库（语料与两套技能），" +
        "没有 git 无法完成安装。请先装 git，或改用已发布的 npm 包（若可用）。",
    );
  }

  let fetched = 0;
  for (const source of SOURCES) {
    if (fetchSource(source)) fetched++;
  }

  const built = buildData();

  console.log(
    `[prepare] done: ${fetched} source(s) cloned, data/ ${built ? "built" : "already present"}`,
  );
}

try {
  main();
} catch (error) {
  console.error("\n[prepare] 安装中止 —— 这个包现在不可用。");
  console.error(`[prepare] 原因：${error?.message ?? error}\n`);
  console.error(
    "[prepare] 这是一个「装不上」而不是「装上了但坏」的失败：缺语料时插件一加载就会报错，" +
      "让你先看到失败比事后在会话里遇到更好。\n",
  );
  process.exit(1);
}
