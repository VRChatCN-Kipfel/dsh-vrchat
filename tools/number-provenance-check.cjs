/**
 * Every hard number in the injected persona must be stated in the corpus.
 *
 * WHY: the plugin's whole promise is "these are tested conclusions, not general
 * advice". A number that silently drifts — or was never in the corpus at all —
 * makes that promise false, and nothing else in the suite would notice. The 10 red
 * lines can be diffed against the source text, but `70,000` and `256 bits` are just
 * digits: they pass every existing check while being wrong.
 *
 * WHAT THIS IS NOT: a proof of correctness. It is a BINDING check — the number has
 * to appear somewhere in the corpus, in a page about the same subject. That catches
 * "I typed 75,000" and "the upstream page changed under us", the two ways this
 * actually goes wrong.
 *
 * Three matching decisions, each made because the naive version of it lied:
 *
 *   · A UNIT-BEARING number must match WITH its unit. `15 KB/s` and `11 KB/s` are
 *     different facts; searching "15" anywhere in 414 pages hits instantly.
 *   · A THOUSANDS-SEPARATED number matches on its digits alone, because the corpus
 *     itself is inconsistent about punctuation (`20,000` vs `20000`).
 *   · A NUMBER ALONE IS NOT PROVENANCE. The number must co-occur with a topic word
 *     taken from the same persona line, in the SAME page. Without this, "15 KB" in
 *     an unrelated tutorial would satisfy a bandwidth claim.
 *
 * Usage: node tools/number-provenance-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CORPUS = path.join(
  ROOT,
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
);

/**
 * Numbers that are NOT corpus facts, exempted explicitly.
 *
 * Anything here is asserted from somewhere else — a build manifest, a tool README,
 * or arithmetic. Naming them is the point: an exemption is a claim that needs a
 * reason, and the dead-exemption check below removes it once nothing uses it.
 *
 * Plugin configuration values are deliberately absent: they live in `index.js` and
 * `cordis.patch.yml`, which this scanner never reads.
 */
const NON_CORPUS = [
  { value: "414", why: "语料页数（构建脚本数出来的，不是语料内容）" },
  { value: "1253", why: "api-table 成员数（由 exposed-types.md 解析得出）" },
  { value: "80", why: "api-table 类型数（同上）" },
  {
    value: "6000.3.1f1",
    why: "persona 刻意引用的反例（Unity 6 时代示例版本），用来警告不要照抄 CLI 的通用示例 —— " +
      "它不在语料里正是重点：语料只收录 VRChat 绑定的两个版本",
  },
];

/** Every corpus page, kept separate so a match can be tied to ONE page. */
function loadPages() {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) {
        pages.push({ name: path.basename(full), text: fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n") });
      }
    }
  };
  walk(CORPUS);
  return pages;
}

/** Whitespace-insensitive form, so `150 MB` in one file matches `150MB` in another. */
const squeeze = (text) => text.replace(/[,\s_]/g, "");

/** Chinese/English topic words on one persona line, longest first. */
function anchorsOf(line) {
  const cjk = line.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  const latin = line.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [];
  const skip = new Set(["约", "全部", "共享", "对应", "的要", "用于", "这个", "如果", "那么"]);
  return [...new Set([...cjk.filter((word) => !skip.has(word)), ...latin])].sort((a, b) => b.length - a.length);
}

/**
 * Numbers worth guarding, and the unit that identifies them.
 *
 * Unity versions are matched separately: `2021.3.22f1` must not be reduced to
 * `2021.3` by the generic decimal pattern, which is what made an earlier version of
 * this check accept a wrong binding.
 */
const VERSION = /\b(\d{4}\.\d+\.\d+f\d+)\b/g;
const NUMBER = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(MB|KB|GB|bits|bytes|byte|tok|ms)(?![\w])/g;
const THOUSANDS = /(\d{1,3}(?:,\d{3})+)(?![\d,\w])/g;

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const pages = loadPages();
const squeezedPages = pages.map((page) => ({ name: page.name, text: squeeze(page.text) }));
const exempt = new Set(NON_CORPUS.map((entry) => entry.value));
const seen = new Set();

const sources = ["content-src/persona-prefix.md", "content-src/t0-core.md"].map((rel) => ({
  rel,
  text: fs.readFileSync(path.join(ROOT, rel), "utf8"),
}));

for (const source of sources) {
  for (const line of source.text.split("\n")) {
    const anchors = anchorsOf(line);

    // ── versions: must exist verbatim in the corpus ──────────────────────
    for (const match of line.matchAll(VERSION)) {
      const version = match[1];
      const key = `v:${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (exempt.has(version)) continue;
      const hit = pages.filter((page) => page.text.includes(version));
      check(
        `${source.rel} 的 Unity 版本 ${version} 来自语料`,
        hit.length > 0,
        `414 页里找不到 ${version}`,
      );
    }

    // ── numbers with a unit: match WITH the unit, in one page ────────────
    for (const match of line.matchAll(NUMBER)) {
      const key = `u:${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const needle = squeeze(match[0]);
      const withUnit = squeezedPages.filter((page) => page.text.includes(needle));
      // The unit is the identity, so a plain hit is real evidence; the anchor check
      // is a second gate that only has to pass when an anchor is available at all.
      const anchored = anchors.length === 0 ? withUnit : withUnit.filter((page) => anchors.some((word) => page.text.includes(word)));
      check(
        `${source.rel} 的 ${match[1]} ${match[2]} 出现在语料的同主题页`,
        withUnit.length > 0 && anchored.length > 0,
        withUnit.length === 0
          ? `任何页都没有 "${needle}"`
          : `"${needle}" 只出现在与主题无关的页面（锚点：${anchors.slice(0, 4).join("/")}）`,
      );
    }

    // ── thousands-separated numbers: digits alone ────────────────────────
    for (const match of line.matchAll(THOUSANDS)) {
      const key = `t:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const needle = squeeze(match[1]);
      const withNumber = squeezedPages.filter((page) => page.text.includes(needle));
      const anchored = anchors.length === 0 ? withNumber : withNumber.filter((page) => anchors.some((word) => page.text.includes(word)));
      check(
        `${source.rel} 的 ${match[1]} 出现在语料的同主题页`,
        withNumber.length > 0 && anchored.length > 0,
        withNumber.length === 0
          ? `任何页都没有 "${needle}"`
          : `"${needle}" 只出现在与主题无关的页面（锚点：${anchors.slice(0, 4).join("/")}）`,
      );
    }
  }
}

// An exemption nothing uses is dead weight — and a stale allowance is exactly what
// lets the next unproven number through.
for (const entry of NON_CORPUS) {
  const used = sources.some((source) => source.text.includes(entry.value));
  check(`豁免 ${entry.value} 仍在使用（${entry.why}）`, used, "已无引用，应删掉这条豁免");
}

let failed = 0;
for (const item of checks) {
  if (!item.ok) {
    failed++;
    console.log(`FAIL  ${item.name}\n      ${item.detail}`);
  }
}
const guarded = seen.size;
console.log("");
console.log(
  failed === 0
    ? `全部 ${checks.length} 条通过（${guarded} 个数值/版本 + ${NON_CORPUS.length} 条豁免）`
    : `${failed} / ${checks.length} 条未通过`,
);
if (failed > 0) process.exitCode = 1;
