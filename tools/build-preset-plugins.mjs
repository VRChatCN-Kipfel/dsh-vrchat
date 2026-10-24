/**
 * Build the `vrchat` preset's plugin list from the SHIPPED `standard` preset.
 *
 * There is no inheritance syntax for agent presets: `@deepseek-ai/dsh-agent-preset`
 * takes `{id, name, description, order, plugins}` and nothing else, and
 * `register(definition)` stores the list verbatim. So a preset that wants the full
 * coding agent must DECLARE the full list — which is exactly what the shipped
 * `av-evasion` preset does (16 top-level rows, three of them `cordis:group`).
 *
 * Rather than hand-copy those rows (and drift the moment upstream edits one),
 * this reads the shipped file and transforms the parsed document:
 *
 *   · `persona`          replaced with our VRChat persona
 *   · `vrchat-kb`        appended
 *   · `vrchat-skills`    appended (skill provider over the vendored submodule)
 *   · `tool-skill`       kept from standard — it is the READER; without it the
 *                        provider's skills are listed nowhere and loadable nowhere
 *   · everything else    kept verbatim, including the three group rows and their
 *                        `isolate` realms (a service row outside such a realm
 *                        publishes into the root realm and the next preset that
 *                        mounts the same service name collides)
 *
 * Usage: node tools/build-preset-plugins.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Locate the shipped `standard.patch.yml` without hardcoding an install path.
 *
 * A literal `D:\\Program Files\\DSH Desktop\\...` is the same mistake as hardcoding
 * the corpus path: correct here, wrong on every other machine, and it fails with a
 * bare ENOENT that says nothing about where it looked.
 *
 * The running desktop shell is the most reliable anchor: `DSH Desktop.exe` sits at
 * `<install>`, and the Host packages are under
 * `<install>/resources/app.asar.unpacked/node_modules/@deepseek-ai/`. A plain
 * `dsh` CLI install, or a build run on a machine with no shell running, still falls
 * through to a search of every plausible root.
 *
 * @returns the absolute path of the preset file.
 * @throws with every path tried, because "not found" alone is not actionable.
 */
function findStandardPatch() {
  const relative = join(
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@deepseek-ai",
    "dsh-web-app",
    "presets",
    "standard.patch.yml",
  );

  const tried = [];
  const addCandidate = (root, why) => {
    const full = resolve(join(root, relative));
    tried.push({ full, why });
    return existsSync(full) ? full : null;
  };

  // 1. The running desktop shell's own directory. On Windows the process image
  //    sits at the install root; `tasklist`-free derivation avoids a hardcoded path.
  for (const imageName of ["DSH Desktop", "DSH Desktop.exe"]) {
    try {
      const out = execFileSync(
        process.platform === "win32" ? "powershell" : "sh",
        process.platform === "win32"
          ? ["-NoProfile", "-Command", `(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`]
          : ["-c", "command -v dsh-desktop || true"],
        { encoding: "utf8", timeout: 8000 },
      ).trim();
      if (out.length === 0) continue;
      const hit = addCandidate(dirname(out), `运行中的 ${imageName}`);
      if (hit !== null) return hit;
      break;
    } catch {
      /* fall through to the next anchor */
    }
  }

  // 2. `DSH_HOME` is always set by the harness; the generation directories carry the
  //    Host packages but nest them one level deeper than the desktop layout.
  if (process.env.DSH_HOME !== undefined) {
    const hit = addCandidate(join(process.env.DSH_HOME, "profiles"), "DSH_HOME/profiles");
    if (hit !== null) return hit;
    // The app.asar layout, rooted at `..` of the harness home's parent.
    const unpacked = join(
      process.env.DSH_HOME,
      "..",
      "..",
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@deepseek-ai",
      "dsh-web-app",
      "presets",
      "standard.patch.yml",
    );
    tried.push({ full: resolve(unpacked), why: "DSH_HOME 向上两级的安装根" });
    if (existsSync(unpacked)) return resolve(unpacked);
  }

  // 3. A profile that happens to ship dsh-web-app as a dependency.
  if (process.env.DSH_PROFILE_DIR !== undefined) {
    const direct = join(
      process.env.DSH_PROFILE_DIR,
      "node_modules",
      "@deepseek-ai",
      "dsh-web-app",
      "presets",
      "standard.patch.yml",
    );
    tried.push({ full: direct, why: "profile node_modules" });
    if (existsSync(direct)) return direct;
  }

  throw new Error(
    `找不到 dsh 自带的 standard.patch.yml，试过：\n` +
      tried.map((item) => `  · ${item.why}\n    ${item.full}`).join("\n") +
      "\n\n没有它就无法知道「标准 agent 挂了哪些插件」，预设会退回少数几行——" +
      "会话将缺少文件、命令与技能工具，而界面看起来完全正常。",
  );
}

const STANDARD = findStandardPatch();
console.log(`standard 预设: ${STANDARD}`);

/**
 * `require` rooted at the HOST's node_modules, so `yaml` resolves out of the DSH
 * installation rather than this package.
 *
 * The anchor is the preset path we already found, not `DSH_PROFILE_DIR`: that env
 * var is an accident of the developer's shell and is ABSENT in the environment this
 * script actually has to work in — `npm install` runs `tools/prepare.js` on a user's
 * machine, where nothing sets it. With it unset the old expression fell back to
 * `join(".", "noop.js")` = the relative path `noop.js`, and `createRequire` rejected
 * it outright:
 *
 *     TypeError: The argument 'filename' must be a file URL object, file URL string,
 *     or absolute path string. Received 'noop.js'
 *
 * That failure never appeared locally because every build here ran with the variable
 * set. Deriving from `STANDARD` removes the env dependency entirely: it is an
 * absolute path inside the same installation, four directories below its root:
 *
 *     <root>/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
 *     ^1      ^2          ^3                 ^4
 */
function hostRequireFrom(presetPath) {
  let dir = dirname(presetPath);
  // Walk up until a `node_modules` directory is visible, so the anchor does not
  // depend on the preset living at a fixed depth inside the installation.
  for (let depth = 0; depth < 8; depth++) {
    const hostModules = join(dir, "node_modules");
    if (existsSync(hostModules)) return createRequire(join(hostModules, "noop.js"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the developer's profile, which is where it used to come from.
  const fallback = process.env.DSH_PROFILE_DIR;
  if (typeof fallback === "string" && fallback.length > 0) {
    const absolute = resolve(fallback);
    if (existsSync(join(absolute, "node_modules"))) {
      return createRequire(join(absolute, "noop.js"));
    }
  }
  throw new Error(
    `找不到 DSH 的 node_modules（用来解析 yaml）：从 ${presetPath} 向上 8 层都没有 node_modules。`,
  );
}

const requireFromProfile = hostRequireFrom(STANDARD);
const YAML = requireFromProfile("yaml");

/** The `!!js` tag the shipped file uses for platform conditionals. */
const jsTag = {
  tag: "tag:yaml.org,2002:js",
  resolve: (value) => value,
  identify: () => false,
};

/**
 * The rows whose `disabled` is a `!!js` expression.
 *
 * `resolve` hands back a plain string, so by the time the document is an object the
 * tag is gone. Re-serializing then writes `disabled: process.platform === 'win32'`
 * — a non-empty string, which YAML reads as truthy, so BOTH platform-gated tools
 * end up disabled instead of one. The shipped file has exactly two such rows, so
 * they are identified by id rather than by rebuilding a general tag-tracking layer.
 *
 * @param text - the raw patch text.
 * @returns the set of ids whose `disabled` must serialize as an expression.
 */
function jsDisabledIds(text) {
  const ids = new Set();
  const lines = text.split("\n");
  let currentId = null;
  for (const line of lines) {
    const idMatch = /^\s{10}- id: (\S+)$/.exec(line);
    if (idMatch) currentId = idMatch[1];
    if (/^\s+disabled:\s*!!js\s/.test(line) && currentId !== null) ids.add(currentId);
  }
  return ids;
}

const source = readFileSync(STANDARD, "utf8");
const doc = YAML.parse(source, { customTags: [jsTag] });
const jsDisabled = jsDisabledIds(source);
console.log(`disabled 是 !!js 表达式的行: ${[...jsDisabled].join(", ")}`);

const standardRow = doc[0].insert.find((row) => row.id === "preset-standard");
if (standardRow === undefined) throw new Error("standard 预设未找到");

const plugins = structuredClone(standardRow.config.plugins);

// Mark the two platform-gated rows so the writer can restore the `!!js` tag.
for (const plugin of plugins) {
  if (jsDisabled.has(plugin.id) && typeof plugin.disabled === "string") {
    plugin.__JS_DISABLED__ = plugin.disabled;
  }
}
console.log(`standard 的插件行数: ${plugins.length}`);

// ── 1. Replace the persona in place, keeping the id so any editor override that
//       targets `persona-` by id still finds it.
const personaIndex = plugins.findIndex((plugin) => plugin.id === "persona");
if (personaIndex === -1) throw new Error("standard 预设里没有 persona 行");
plugins[personaIndex] = {
  id: "persona",
  name: "@deepseek-ai/dsh-persona",
  config: {
    // Placeholders are filled by build-knowledge.mjs, which owns the persona text.
    prefix: "__PERSONA_PREFIX__",
    suffix: "__PERSONA_SUFFIX__",
  },
};
console.log(`替换 persona（原 id 保留，位置 ${personaIndex}）`);

// ── 2. Append the knowledge base and the skill provider. Appended rather than
//       inserted early so the standard tool rows keep their relative order.
plugins.push({
  id: "vrchat-kb-preset",
  name: "dsh-vrchat",
  config: { tier: "preset" },
});
plugins.push({
  id: "vrchat-skills",
  name: "@deepseek-ai/dsh-skill-filesystem",
  config: {
    providerName: "vrchat-skills",
    // `includeDefaultRoots` is deliberately NOT set: this row keeps the documented
    // default (`true`), so it scans ~/.agents/skills / DSH_HOME/skills / project
    // roots on top of the two vendored roots below.
    //
    // It used to be pinned to `false` to avoid a second scan: the `skill-filesystem`
    // row above already covers the default roots, so both providers return the same
    // user skills and the registry drops the duplicates by name ("higher-priority
    // skill already exists"). That saving bought nothing and cost something real —
    // a config that no longer matches the documented default, in the one row whose
    // job is to make skills reachable. The overlap is silent by design: duplicates
    // are resolved first-wins, never double-listed, never double-loaded.
    //
    // Keeping the default is also what lets a skill the AGENT installs mid-session
    // (e.g. `npx skills add <repo> --skill <name>`, booth-vault-toolhub's own
    // supported entry) show up without touching this file: the provider re-scans
    // the default roots, so the next catalogue read sees it.
    customSkillDirs: [
      { __JS__: "process.getBuiltinModule('node:url').fileURLToPath(new URL('vendor/vrchat-world-codex-skills/', baseUrl))" },
      { __JS__: "process.getBuiltinModule('node:url').fileURLToPath(new URL('vendor/vrchat-editor-skill/', baseUrl))" },
      // Ours, not vendored from anywhere: the VPM CLI (`vrc-get`, the engine behind
      // ALCOM). One skill plus four references, so the catalogue pays 274 characters
      // and the 12 KB of detail is only read when the skill is actually loaded.
      { __JS__: "process.getBuiltinModule('node:url').fileURLToPath(new URL('vendor/vrc-get-cli/', baseUrl))" },
    ],
  },
});

// ── 2b. Raise the catalogue's per-description budget in THIS preset only.
//
// The reader truncates every description at `catalogDescriptionMaxLength`
// (default 500) when it renders the `- \`name\`: description` lines, and the
// catalogue line is the ENTIRE routing signal — the body is only read after the
// model picks the skill. A description longer than the budget therefore loses its
// tail silently, and the tail is exactly where a skill states its exclusions.
//
// The vendored editor skill measures 795 characters and its last sentence is
// "Do not use for VRChat World or Udon projects" — without it the skill competes
// with the four World skills for every World request. Rewriting the upstream file
// would fork the submodule; raising the budget keeps the repository verbatim.
//
// 1024 rather than 795: it leaves room for the upstream skill to grow, and the
// four user-installed skills that currently get cut (ci-watch 522, excel-cli 519,
// dynamic-archify 804, vue-bits 818) fit too. The row lives inside
// `preset-vrchat`, not the global row, so no other session pays for it.
const catalogueReader = plugins.find((plugin) => plugin.id === "tool-skill");
if (catalogueReader === undefined) throw new Error("standard 预设里没有 tool-skill 行");
catalogueReader.config = { ...(catalogueReader.config ?? {}), catalogDescriptionMaxLength: 1024 };
console.log("tool-skill 的 catalogDescriptionMaxLength → 1024（仅本预设）");

// ── 3. State the two things a later reader must not silently drop.
const hasReader = plugins.some((plugin) => plugin.id === "tool-skill");
const hasProvider = plugins.some((plugin) => plugin.id === "vrchat-skills");
if (!hasReader || !hasProvider) {
  throw new Error(`技能通道不成对：provider=${hasProvider} reader=${hasReader}`);
}

// Both skill roots must survive as `!!js`, or the provider finds nothing and the
// catalogue comes up empty with no error. Counting entries is the cheap check.
// The expected count is derived from what we pushed, not hardcoded: the number of
// skill roots has grown (2 → 3) and a literal here turns every addition into a
// build failure that says "should be 2" rather than "the !!js tag was lost".
const skillDirs = plugins.find((plugin) => plugin.id === "vrchat-skills")?.config?.customSkillDirs ?? [];
const jsDirs = skillDirs.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.__JS__ === "string");
if (jsDirs.length !== skillDirs.length || skillDirs.length === 0) {
  throw new Error(`技能目录应有 ${skillDirs.length} 个 !!js 表达式，实际 ${jsDirs.length}`);
}

console.log(`最终插件行数: ${plugins.length}`);
console.log("条目:");
for (const plugin of plugins) {
  const kind = plugin.name === "cordis:group" ? `group(${(plugin.config ?? []).length} 子行)` : plugin.name;
  console.log(`  ${String(plugin.id).padEnd(26)} ${kind}`);
}

writeFileSync(
  join(process.argv[2] ?? ".", "preset-plugins.json"),
  JSON.stringify(plugins, null, 2),
  "utf8",
);
console.log("\n已写入 preset-plugins.json（供 build-knowledge.mjs 消费）");
