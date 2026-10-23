/**
 * Locate the installed DSH Host packages without hardcoding an install path.
 *
 * Five tools each carried a literal `D:\Program Files\DSH Desktop\resources\
 * app.asar.unpacked\node_modules`. That is the same class of mistake as hardcoding
 * the corpus path: correct on this machine, wrong on every other one, and the
 * failure is a bare ENOENT that says nothing about where it looked.
 *
 * The anchors, in order of reliability:
 *
 *   1. The running desktop shell. `DSH Desktop.exe` sits at the install root, and
 *      the Host packages are under `<install>/resources/app.asar.unpacked/`. This
 *      is the only anchor that survives an install somewhere unexpected.
 *   2. A `.generations/live/<id>/node_modules` directory. Those ship the Host
 *      packages as dependencies, so any installed plugin generation that depends on
 *      a Host package can answer the question from inside.
 *   3. `DSH_PROFILE_DIR/node_modules` — the profile's own dependency tree.
 *   4. `process.execPath`'s directory and its parent. This is where a `node`
 *      shipped inside the app would sit; it is last because a system `node`
 *      points somewhere unrelated.
 *
 * Every miss is collected so the thrown message lists what was tried.
 *
 * Usage:
 *   const { findHostModules } = require("./lib-host-modules.cjs");
 *   const dir = findHostModules();            // .../node_modules
 *   const aiDir = findHostModules("dsh-tools/lib/index.js");   // .../node_modules/...
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** Directory suffixes that hold Host packages under an install root. */
const HOST_SUFFIX = ["resources", "app.asar.unpacked", "node_modules"];

/** @returns the running desktop shell's install root, or null. */
function shellInstallRoot() {
  if (process.platform !== "win32") {
    // A POSIX desktop shell is not shipped as a plain executable; there is nothing
    // reliable to derive here, so fall through to the other anchors.
    return null;
  }
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"],
      { encoding: "utf8", timeout: 8000 },
    ).trim();
    return out.length === 0 ? null : path.dirname(out);
  } catch {
    return null;
  }
}

/** @returns every candidate `<...>/node_modules` root, with provenance. */
function hostCandidates() {
  const tried = [];

  const add = (base, why, suffix = HOST_SUFFIX) => {
    const full = path.resolve(path.join(base, ...suffix));
    tried.push({ full, why });
    return full;
  };

  const root = shellInstallRoot();
  if (root !== null) add(root, "运行中的 DSH Desktop 安装根");

  // Generations that depend on a Host package, newest first.
  if (process.env.DSH_HOME !== undefined) {
    const live = path.join(process.env.DSH_HOME, "profiles", ".generations", "live");
    if (fs.existsSync(live)) {
      let names = [];
      try {
        names = fs.readdirSync(live).sort();
      } catch {
        names = [];
      }
      for (const name of names) add(path.join(live, name), `已安装代 ${name}`, ["node_modules"]);
    }
  }

  if (process.env.DSH_PROFILE_DIR !== undefined) {
    add(process.env.DSH_PROFILE_DIR, "DSH_PROFILE_DIR", ["node_modules"]);
  }

  add(path.dirname(process.execPath), "process.execPath 所在目录");
  add(path.dirname(path.dirname(process.execPath)), "process.execPath 的父目录");

  return tried;
}

/**
 * Find a Host modules root.
 *
 * @param relative - optional path WITHIN the modules root to confirm, e.g.
 *   `"dsh-tools/lib/index.js"` when the caller needs that exact package.
 * @returns the absolute modules root (or its extension), or throws listing every
 *   candidate tried.
 */
function findHostModules(relative) {
  const tried = hostCandidates();
  for (const candidate of tried) {
    const base = relative === undefined ? candidate.full : path.join(candidate.full, ...relative.split("/"));
    if (fs.existsSync(base)) return relative === undefined ? candidate.full : base;
  }
  // Every generation's node_modules is a candidate, so this list runs to twenty-odd
  // entries. Printing all of them buries the one fact that matters — that a working
  // install was not among them. Show the distinct WHYs, plus the full list to a file.
  const seenWhys = [...new Set(tried.map((item) => item.why))];
  const listing = tried.map((item) => `  · ${item.why}\n    ${item.full}`).join("\n");
  throw new Error(
    `找不到 DSH 的 Host 包${relative === undefined ? "" : `（需要 ${relative}）`}。\n` +
      `试过的位置类别（共 ${tried.length} 处）：\n` +
      seenWhys.map((why) => `  · ${why}`).join("\n") +
      `\n\n完整清单：\n${listing}\n\n` +
      "这些检查需要 DSH 自己的实现来验证行为（真实校验器 / 真实 provider），" +
      "自己重写一份就变成了「验证我的理解」而不是「验证事实」。",
  );
}

/** Convenience: a `createRequire` rooted at the Host modules. */
function hostRequireFactory() {
  const { createRequire } = require("node:module");
  return createRequire(path.join(findHostModules(), "noop.js"));
}

module.exports = { findHostModules, hostCandidates, hostRequireFactory };
