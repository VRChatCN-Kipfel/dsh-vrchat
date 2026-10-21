/**
 * Offline self-test for the library-scoped read/grep pair.
 *
 * Assertions follow the OFFICIAL tool conventions, because the point of
 * mirroring them is that an agent's existing habits transfer unchanged.
 *
 * The pair now takes a LAZY reader plus the indexed paths, not a page map:
 * page bodies live in the workspace checkout and are opened on demand. So this
 * test builds a reader over the real corpus, and a second one that returns null
 * to prove the "corpus missing" path reports itself instead of pretending.
 *
 * Usage: node tools/docs-selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");

async function main() {
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);

  const corpusRoot = search.findCorpusRoot(root);
  const index = JSON.parse(fs.readFileSync(path.join(root, "data", "index.json"), "utf8"));
  const paths = index.map((entry) => entry.path);

  /** Real lazy reader over the corpus checkout. */
  const read = (rel) => {
    if (corpusRoot === null) return null;
    try {
      return fs.readFileSync(path.join(corpusRoot, ...rel.split("/")), "utf8");
    } catch {
      return null;
    }
  };
  /** Reader that simulates a workspace without the checkout. */
  const readNothing = () => null;

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  // ── path translation (the only thing this layer owns) ────────────────────
  check("精确路径", docs.resolvePage(paths, "concepts/rules/udonsharp-language-limits.md") === "concepts/rules/udonsharp-language-limits.md");
  check("省略 .md", docs.resolvePage(paths, "concepts/rules/udonsharp-language-limits") === "concepts/rules/udonsharp-language-limits.md");
  check(
    "submodule 绝对路径被换算",
    docs.resolvePage(
      paths,
      "D:/x/VRChat-Agent-Creator-Library/memoryV5.0.0/LLMWikiExample/LLMWikiPage/entities/api/not-exposed.md",
    ) === "entities/api/not-exposed.md",
  );
  check("反斜杠路径被换算", docs.resolvePage(paths, "entities\\api\\not-exposed.md") === "entities/api/not-exposed.md");
  check("唯一 basename 被换算", docs.resolvePage(paths, "not-exposed.md") === "entities/api/not-exposed.md");
  check("无法解析返回 null（不抛建议）", docs.resolvePage(paths, "no/such/page.md") === null);

  // ── read: official conventions ──────────────────────────────────────────
  const total = read("entities/api/not-exposed.md").split("\n").length;
  const first = docs.readPage(read, paths, "entities/api/not-exposed.md", 1, 5);
  check("行号格式 `N: text`", first.ok && /^\s*1: /.test(first.text.split("\n")[0]), first.text.split("\n")[0]);
  check("续读脚注是官方式样", first.text.includes("Use offset=6 to continue"), first.text.split("\n").at(-1));

  const tail = docs.readPage(read, paths, "entities/api/not-exposed.md", total - 2, 100);
  check("末尾显示 End of file", tail.ok && tail.text.includes(`(End of file - total ${total} lines)`), tail.text.split("\n").at(-1));

  check("offset 越界报错", !docs.readPage(read, paths, "entities/api/not-exposed.md", total + 1, 10).ok);
  check("limit 上限截断", docs.readPage(read, paths, "entities/avatar/modular-avatar.md", 1, 99999).lines.length === 400);
  check("默认 limit 200", docs.readPage(read, paths, "entities/avatar/modular-avatar.md", 1).lines.length === 200);
  check("读不存在的页面报错", !docs.readPage(read, paths, "no/such/page.md").ok);

  // ── read: corpus missing must say so ───────────────────────────────────
  const noCorpus = docs.readPage(readNothing, paths, "entities/api/not-exposed.md");
  check("无语料时 read 失败", !noCorpus.ok);
  check("无语料时说明是 checkout 缺失", /corpus checkout is missing/.test(noCorpus.text), noCorpus.text.slice(0, 90));

  // ── grep: official conventions ──────────────────────────────────────────
  const grep = docs.grepPages(paths, read, "PropertyToID", { maxMatches: 20 });
  check("头部是 Found N matches", grep.ok && /^Found \d+ match/.test(grep.text.split("\n")[0]), grep.text.split("\n")[0]);
  check("按文件分组并带 Line N:", grep.ok && /\nLine \d+: /.test(grep.text));
  check("无命中返回 No matches found", docs.grepPages(paths, read, "zzzz-not-present-zzzz").text === "No matches found");
  check("无效正则被拒绝", !docs.grepPages(paths, read, "[unclosed").ok);

  const capped = docs.grepPages(paths, read, "Udon", { maxMatches: 5 });
  check("截断时报告 total", capped.ok && capped.matches.length === 5 && capped.total > 5, `total=${capped.total}`);
  check("截断头部形如 Found X of Y", /^Found 5 of \d+ matches/.test(capped.text.split("\n")[0]), capped.text.split("\n")[0]);

  // ── include filter ──────────────────────────────────────────────────────
  const inMd = docs.grepPages(paths, read, "toon", { include: "*.md", maxMatches: 5 });
  check("include: *.md 匹配全部库页", inMd.ok && inMd.matches.every((m) => m.path.endsWith(".md")), inMd.text.split("\n")[0]);
  const narrowed = docs.grepPages(paths, read, "Udon", { include: "limits-and-quirks.md", maxMatches: 5 });
  check(
    "include: 单文件收窄生效",
    narrowed.ok && narrowed.matches.every((m) => m.path.endsWith("limits-and-quirks.md")),
    narrowed.text.split("\n")[0],
  );
  const brace = docs.grepPages(paths, read, "Udon", { include: "{index,limits-and-quirks}.md", maxMatches: 5 });
  check(
    "include 支持 {a,b}",
    brace.ok && brace.matches.every((m) => /\/(index|limits-and-quirks)\.md$/.test(m.path)),
    `paths: ${[...new Set(brace.matches.map((m) => m.path))].join(", ")}`,
  );

  // ── grep: corpus missing must say so, not "no matches" ─────────────────
  const bareGrep = docs.grepPages(paths, readNothing, "Udon");
  check("无语料时 grep 失败", !bareGrep.ok);
  check(
    "无语料时不谎称 No matches found",
    !/^No matches found$/.test(bareGrep.text) && /corpus checkout is missing/.test(bareGrep.text),
    bareGrep.text.slice(0, 90),
  );

  // ── chain: grep → read ──────────────────────────────────────────────────
  const hit = docs.grepPages(paths, read, "RULE-LL-12", { maxMatches: 1 });
  const firstMatch = hit.matches?.[0];
  const near = docs.readPage(read, paths, firstMatch.path, Math.max(1, firstMatch.lineNumber - 2), 5);
  check("grep 结果直接喂给 read", near.ok, near.path);

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail === undefined ? "" : `\n      ${item.detail}`}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
