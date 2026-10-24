/**
 * Verify the injected section no longer duplicates the persona suffix.
 *
 * The previous version of this check measured build artifacts, which still contain
 * both blocks, so it could not see the runtime decision. This one asks index.js
 * itself for the section it registers, then compares against the suffix the patch
 * actually ships.
 *
 * Why the section comes from a real `apply()` call rather than a regex over the
 * source: the text is Markdown containing inline code (`vrchat_kb`), and a
 * `[^"`]*` character class stops at the first backtick. That silently measured
 * 551 characters where the real section is 734 — a checker under-reporting the
 * thing it checks, which is the same class of bug as the one it exists to catch.
 *
 * Usage: node tools/duplication-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadFromHost } = require("./lib-host-require.cjs");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const requireFromProfile = loadFromHost;
const YAML = requireFromProfile("yaml");

/**
 * Run `apply()` with a stub context and read the registered section back.
 *
 * Harness-only imports are replaced because they resolve only inside a profile.
 * `Config` is schemastery and irrelevant to what we measure.
 *
 * The temp module is deliberately left on disk: `fs.rmSync` crashes Node 24.9.0 on
 * Windows with 0xC0000409, a `__fastfail` that bypasses every JS-level handler.
 */
async function loadSectionText(source) {
  const noop = new Proxy({}, { get: (_target, key) => (key === "default" ? () => noop : () => noop) });
  const patched = source
    .replace(/import z from "@deepseek-ai\/schemastery";/, "const z = globalThis.__z;")
    .replace(/import \{ z as zod \} from "zod";/, "const zod = globalThis.__z;")
    .replace(/import \{ defineTool \} from "@deepseek-ai\/dsh-tools";/, "const defineTool = (d) => d;");
  globalThis.__z = noop;
  const tmp = path.join(root, ".duplication-section.mjs");
  fs.writeFileSync(tmp, patched, "utf8");

  const captured = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    systemPrompt: { section: (def) => (captured.push(def), () => {}) },
    tools: { register: () => () => {} },
    effect: (fn) => (fn(), () => {}),
    get: () => undefined,
  };

  // `tier: preset` is the only configuration that registers a section at all.
  const mod = await import(`${pathToFileURL(tmp).href}?v=${Date.now()}`);
  mod.apply(ctx, { tier: "preset" });
  const section = captured.find((def) => def.name === "vrchat-kb");
  if (section === undefined) throw new Error("apply() 没有注册 vrchat-kb section —— 无法检查重复");
  return section.text;
}

async function main() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const patch = YAML.parse(fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8"));
  const preset = patch[0].insert.find((row) => row.id === "preset-vrchat");
  const persona = preset.config.plugins.find((plugin) => plugin.id === "persona");
  const suffix = persona.config.suffix ?? "";

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "manifest.json"), "utf8"));
  const t0 = fs.readFileSync(path.join(root, "data", "t0-core.txt"), "utf8");
  const always = fs.readFileSync(path.join(root, "data", "always-load.txt"), "utf8");

  const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const sectionText = await loadSectionText(source);

  // The provenance line the plugin builds, for the "says where it came from" check.
  const provenance = [
    `库 v${manifest.libraryVersion ?? "?"} / 上游 ${manifest.pageCount ?? "?"} 页 / 构建 ${String(manifest.builtAt ?? "").slice(0, 10)}`,
    `本块 ${manifest.blocks?.["always-load"]?.tokensLow ?? "?"}–${manifest.blocks?.["always-load"]?.tokensHigh ?? "?"} tok`,
  ].join(" · ");

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

  // ── the assertions ────────────────────────────────────────────────────
  check("section 至少含构建来源信息", /v\d|构建/.test(sectionText), provenance);
  check("section 不再内联 t0 红线", !sectionText.includes(t0Body.slice(0, 200)));
  check("section 不再内联 always-load", !sectionText.includes(alwaysBody.slice(0, 200)));

  // The real measure: how much of the section appears verbatim in the suffix.
  let covered = 0;
  for (const line of sectionText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 16) continue;
    if (suffix.includes(trimmed)) covered += line.length;
  }
  const ratio = sectionText.length === 0 ? 1 : covered / sectionText.length;
  console.log("");
  console.log(`  与 suffix 的逐字重合：${covered} / ${sectionText.length} = ${(ratio * 100).toFixed(1)}%`);

  check("逐字重合率 < 5%", ratio < 0.05, `${(ratio * 100).toFixed(1)}%`);

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
