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
import { join } from "node:path";

const HOST_PRESETS = join(
  "D:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh-web-app\\presets",
);
const STANDARD = join(HOST_PRESETS, "standard.patch.yml");

const requireFromProfile = createRequire(join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
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
  name: "dsh-vrchat-kb",
  config: { tier: "preset" },
});
plugins.push({
  id: "vrchat-skills",
  name: "@deepseek-ai/dsh-skill-filesystem",
  config: {
    providerName: "vrchat-skills",
    customSkillDirs: [{ __JS__: "process.getBuiltinModule('node:url').fileURLToPath(new URL('vendor/vrchat-world-codex-skills/', baseUrl))" }],
  },
});

// ── 3. State the two things a later reader must not silently drop.
const hasReader = plugins.some((plugin) => plugin.id === "tool-skill");
const hasProvider = plugins.some((plugin) => plugin.id === "vrchat-skills");
if (!hasReader || !hasProvider) {
  throw new Error(`技能通道不成对：provider=${hasProvider} reader=${hasReader}`);
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
