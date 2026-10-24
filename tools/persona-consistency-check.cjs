/**
 * The persona text in `data/` must be byte-identical to what the patch injects.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: a plugin cannot read its own sibling's
 * config. `index.js` therefore sizes the persona by reading `data/persona-*.txt`,
 * while the actual injection comes from `cordis.patch.yml`'s `persona` row. Two
 * sources, one truth — and the ledger's `injectedChars` is only correct while they
 * agree. If they drift, the plugin reports a cost for text it did not inject, and
 * the dock shows a number that is quietly wrong in the one place a human looks.
 *
 * Drift is not hypothetical: `build-knowledge.mjs` writes both from one source, so
 * they agree after a build — but only after a build. Editing `content-src/` without
 * rebuilding, or hand-editing the patch (which its header forbids), breaks it.
 *
 * Usage: node tools/persona-consistency-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.join(__dirname, "..");
const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");

/** The `!!js` tag appears in the patch; parse it instead of warning four times. */
const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value) => value, identify: () => false };

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const patch = YAML.parse(fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8"), {
  customTags: [jsTag],
});
const preset = patch[0].insert.find((row) => row.id === "preset-vrchat");
const persona = preset?.config?.plugins?.find((plugin) => plugin.id === "persona");

check("补丁里有 preset-vrchat", preset !== undefined);
check("预设里有 persona 行", persona !== undefined);

const injected = { prefix: persona?.config?.prefix ?? "", suffix: persona?.config?.suffix ?? "" };

for (const [name, injectedText] of Object.entries(injected)) {
  const file = path.join(ROOT, "data", `persona-${name}.txt`);
  if (!fs.existsSync(file)) {
    check(`data/persona-${name}.txt 存在`, false, "缺文件：先运行 node tools/build-knowledge.mjs");
    continue;
  }
  const onDisk = fs.readFileSync(file, "utf8");

  check(
    `data/persona-${name}.txt 与注入内容逐字相等`,
    onDisk === injectedText,
    onDisk === injectedText
      ? `${onDisk.length} 字符`
      : `磁盘 ${onDisk.length} 字符 / 注入 ${injectedText.length} 字符 —— 内容漂移，请重跑构建`,
  );

  // When they differ, say WHERE. "not equal" alone sends the reader diffing 10 KB
  // by hand; the first divergence is almost always the whole story (a stale build
  // after a content-src edit).
  if (onDisk !== injectedText) {
    let index = 0;
    while (index < onDisk.length && index < injectedText.length && onDisk[index] === injectedText[index]) index++;
    const around = (text) => JSON.stringify(text.slice(Math.max(0, index - 30), index + 40));
    check(`  首个差异位置（${name}）`, false, `字符 ${index}\n      磁盘: ${around(onDisk)}\n      注入: ${around(injectedText)}`);
  }
}

// The suffix is what the ledger is sized from, so its composition is worth stating:
// t0's heading is replaced, not kept, and `always-load` is appended verbatim.
const suffixText = injected.suffix;
if (suffixText.length > 0) {
  const t0 = fs.readFileSync(path.join(ROOT, "data", "t0-core.txt"), "utf8");
  const always = fs.readFileSync(path.join(ROOT, "data", "always-load.txt"), "utf8");
  const t0Body = t0.replace(/^# .*\n+/, "").trim();
  check("suffix 用的是自己的标题（不是 t0 的）", !suffixText.startsWith(t0.split("\n")[0]), suffixText.split("\n")[0]);
  check("suffix 含 t0 正文", suffixText.includes(t0Body.slice(0, 200)));
  check("suffix 含 always-load", suffixText.includes(always.trim().slice(0, 200)));
}

let failed = 0;
for (const item of checks) {
  if (!item.ok) {
    failed++;
    console.log(`FAIL  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
  }
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过（prefix ${injected.prefix.length} / suffix ${injected.suffix.length}）` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
