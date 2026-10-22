/**
 * Verify the injected section no longer duplicates the persona suffix.
 *
 * The previous version of this check measured build artifacts, which still contain
 * both blocks, so it could not see the runtime decision. This one reads the
 * section text the way index.js composes it — by requiring nothing, just parsing
 * the constants the plugin builds — and compares against the suffix that the
 * patch actually ships.
 *
 * Usage: node tools/duplication-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.join(__dirname, "..");
const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const patch = YAML.parse(fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8"));
const preset = patch[0].insert.find((row) => row.id === "preset-vrchat");
const persona = preset.config.plugins.find((plugin) => plugin.id === "persona");
const suffix = persona.config.suffix ?? "";

const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "manifest.json"), "utf8"));
const t0 = fs.readFileSync(path.join(root, "data", "t0-core.txt"), "utf8");
const always = fs.readFileSync(path.join(root, "data", "always-load.txt"), "utf8");

// ── what index.js injects at order 640 ──────────────────────────────────
//
// Read the literal from the source rather than re-deriving it: if someone puts
// the blocks back, this must notice.
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
const sectionMatch = /const sectionText = \[([\s\S]*?)\]\.join\("\\n"\);/.exec(source);
check("能定位 sectionText 的构造", sectionMatch !== null);

const sectionLiterals = sectionMatch === null
  ? []
  : // Both quote styles: the first line is a template literal (it interpolates
    // `${provenance}`), the rest are plain double-quoted strings.
    [...sectionMatch[1].matchAll(/[`"]([^`"]*)[`"]/g)].map((match) => match[1]);
const sectionShape = sectionLiterals.join("\n");

// The provenance line is interpolated, so substitute its real value.
const provenance = [
  `库 v${manifest.libraryVersion ?? "?"} / 上游 ${manifest.pageCount ?? "?"} 页 / 构建 ${String(manifest.builtAt ?? "").slice(0, 10)}`,
  `本块 ${manifest.blocks?.["always-load"]?.tokensLow ?? "?"}–${manifest.blocks?.["always-load"]?.tokensHigh ?? "?"} tok`,
].join(" · ");
// The first line of the array carries the interpolation; rebuild it explicitly so
// the measured text is the text the plugin really injects.
const sectionLines = sectionLiterals.map((line) =>
  line.includes("${provenance}") ? line.replace('${provenance}', provenance) : line,
);
const sectionText = sectionLines.join("\n");

// The suffix STRIPS t0's own heading and prepends its own (build-knowledge.mjs),
// so compare against the body, not the raw file — otherwise every check below
// fails on a heading that is deliberately different.
const t0Body = t0.replace(/^# .*\n+/, "").trim();
const alwaysBody = always.trim();

console.log("注入组成");
console.log(`  suffix (order 10200)  ${suffix.length} 字符`);
console.log(`  section (order  640)  ${sectionText.length} 字符`);
console.log("");
console.log("section 的内容：");
for (const line of sectionText.split("\n")) console.log(`  | ${line}`);

// ── the assertions ──────────────────────────────────────────────────────
check("section 至少含构建来源信息", /v\d|构建/.test(sectionText), provenance);
check("section 不再内联 t0 红线", !sectionText.includes(t0Body.slice(0, 200)));
check("section 不再内联 always-load", !sectionText.includes(alwaysBody.slice(0, 200)));

// The real measure: how much of the section appears verbatim in the suffix.
const covered = (() => {
  let total = 0;
  for (const line of sectionText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 16) continue;
    if (suffix.includes(trimmed)) total += line.length;
  }
  return total;
})();
const ratio = sectionText.length === 0 ? 1 : covered / sectionText.length;
console.log("");
console.log(`  与 suffix 的逐字重合：${covered} / ${sectionText.length} = ${(ratio * 100).toFixed(1)}%`);

check("逐字重合率 < 5%", ratio < 0.05, `${(ratio * 100).toFixed(1)}%`);

// And the total saved.
const before = suffix.length + t0.length + 5 + always.length;
const after = suffix.length + sectionText.length;
console.log(`  预设注入总量：曾 ${before} 字符 → 现 ${after} 字符（省 ${before - after}）`);
check("总量显著下降", before - after > 6000, `省 ${before - after} 字符`);

// The red lines must still be reachable — removing them from one place must not
// remove them from the other.
check("红线仍在 suffix 里", suffix.includes(t0Body.slice(0, 200)));
check("suffix 仍含 always-load", suffix.includes(alwaysBody.slice(0, 200)));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
