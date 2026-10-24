/**
 * Load `yaml` for the tools, without depending on a developer's shell.
 *
 * THE BUG THIS REPLACES. Thirteen scripts spelled the lookup like this:
 *
 *     createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"))
 *
 * With the variable set that is an absolute path and works. With it UNSET — which is
 * the norm: a fresh checkout, a CI run, `npm install` on a user's machine — the
 * expression degenerates to the RELATIVE path `./noop.js`, and `createRequire`
 * refuses it:
 *
 *     TypeError: The argument 'filename' must be a file URL object, file URL string,
 *     or absolute path string. Received './noop.js'
 *
 * The failure was invisible locally for the usual reason: every run here exported the
 * variable. It is the same shape as the defect in `build-preset-plugins.mjs`, which
 * is why the whole class is fixed once, here, instead of thirteen times.
 *
 * `yaml` is now a declared dependency (it has to be: `tools/prepare.js` runs on the
 * user's machine during `npm install`), so the package's own resolution comes first.
 * The DSH tree stays as a fallback for a source checkout that has not run
 * `npm install`.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

/** Candidate `node_modules` roots, in order, each validated before use. */
function moduleRoots() {
  const roots = [];
  // 1. This package's own dependencies — correct wherever it is installed.
  const root = path.join(__dirname, "..");
  roots.push(root);
  // 2. The developer's profile, when it really exists.
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === "string" && profile.length > 0) {
    const absolute = path.resolve(profile);
    if (fs.existsSync(path.join(absolute, "node_modules"))) roots.push(absolute);
  }
  return roots.filter((candidate) => fs.existsSync(path.join(candidate, "node_modules")));
}

/**
 * @param {string} name - the module to load, e.g. `"yaml"`.
 * @returns the loaded module.
 * @throws with every root tried, because "cannot find module" alone is not actionable.
 */
function loadFromHost(name) {
  const tried = [];
  // Plain `require` first: it walks up from this file, so a normal install works.
  try {
    return require(name);
  } catch (error) {
    tried.push(`require("${name}") -> ${error?.code ?? error?.message}`);
  }
  for (const root of moduleRoots()) {
    const anchor = path.join(root, "noop.js");
    try {
      return createRequire(anchor)(name);
    } catch (error) {
      tried.push(`${anchor} -> ${error?.code ?? error?.message}`);
    }
  }
  throw new Error(
    `无法加载 "${name}"。已尝试：\n  ${tried.join("\n  ")}\n` +
      `本包已声明该依赖，源码目录请先运行 npm install。`,
  );
}

module.exports = { loadFromHost, moduleRoots };
