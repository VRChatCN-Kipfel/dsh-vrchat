/**
 * Offline self-test for the library-scoped read/grep pair.
 *
 * Assertions follow the OFFICIAL tool conventions, because the point of
 * mirroring them is that an agent's existing habits transfer unchanged.
 *
 * Usage: node tools/docs-selftest.cjs
 */
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "docs.js")).href);
  const pages = JSON.parse(fs.readFileSync(join(__dirname, "..", "data", "pages.json"), "utf8"));

  const checks = [];
  const check = (name, condition, detail) => checks.push({ name, ok: Boolean(condition), detail });

  // ── path translation (the only thing this layer owns) ────────────────────
  check("精确路径", mod.resolvePage(pages, "concepts/rules/udonsharp-language-limits.md") === "concepts/rules/udonsharp-language-limits.md");
  check("省略 .md", mod.resolvePage(pages, "concepts/rules/udonsharp-language-limits") === "concepts/rules/udonsharp-language-limits.md");
  check(
    "submodule 绝对路径被换算",
    mod.resolvePage(
      pages,
      "D:/x/VRChat-Agent-Creator-Library/memoryV5.0.0/LLMWikiExample/LLMWikiPage/entities/api/not-exposed.md",
    ) === "entities/api/not-exposed.md",
  );
  check("反斜杠路径被换算", mod.resolvePage(pages, "entities\\api\\not-exposed.md") === "entities/api/not-exposed.md");
  check("唯一 basename 被换算", mod.resolvePage(pages, "not-exposed.md") === "entities/api/not-exposed.md");
  check("无法解析返回 null（不抛建议）", mod.resolvePage(pages, "no/such/page.md") === null);

  // ── read: official conventions ──────────────────────────────────────────
  const total = pages["entities/api/not-exposed.md"].split("\n").length;
  const first = mod.readPage(pages, "entities/api/not-exposed.md", 1, 5);
  check("行号格式 `N: text`", first.ok && /^\s*1: /.test(first.text.split("\n")[0]), first.text.split("\n")[0]);
  check("续读脚注是官方式样", first.text.includes(`Use offset=6 to continue`), first.text.split("\n").at(-1));

  const tail = mod.readPage(pages, "entities/api/not-exposed.md", total - 2, 100);
  check("末尾显示 End of file", tail.ok && tail.text.includes(`(End of file - total ${total} lines)`), tail.text.split("\n").at(-1));

  check("offset 越界报错", !mod.readPage(pages, "entities/api/not-exposed.md", total + 1, 10).ok);
  check("limit 上限截断", mod.readPage(pages, "entities/avatar/modular-avatar.md", 1, 99999).lines.length === 400);
  check("默认 limit 200", mod.readPage(pages, "entities/avatar/modular-avatar.md", 1).lines.length === 200);
  check("读不存在的页面报错", !mod.readPage(pages, "no/such/page.md").ok);

  // ── grep: official conventions ──────────────────────────────────────────
  const grep = mod.grepPages(pages, "PropertyToID", { maxMatches: 20 });
  check("头部是 Found N matches", grep.ok && /^Found \d+ match/.test(grep.text.split("\n")[0]), grep.text.split("\n")[0]);
  check("按文件分组并带 Line N:", grep.ok && /\nLine \d+: /.test(grep.text), grep.text.split("\n").slice(0, 3).join(" | "));
  check("无命中返回 No matches found", mod.grepPages(pages, "zzzz-not-present-zzzz").text === "No matches found");
  check("无效正则被拒绝", !mod.grepPages(pages, "[unclosed").ok);

  const capped = mod.grepPages(pages, "Udon", { maxMatches: 5 });
  check("截断时报告 total", capped.ok && capped.matches.length === 5 && capped.total > 5, `total=${capped.total} shown=${capped.matches.length}`);
  check("截断头部形如 Found X of Y", /^Found 5 of \d+ matches/.test(capped.text.split("\n")[0]), capped.text.split("\n")[0]);

  // ── include filter ──────────────────────────────────────────────────────
  const inMd = mod.grepPages(pages, "toon", { include: "*.md", maxMatches: 5 });
  check("include: *.md 匹配全部库页", inMd.ok && inMd.matches.every((m) => m.path.endsWith(".md")), inMd.ok ? inMd.text.split("\n")[0] : inMd.text);
  const narrowed = mod.grepPages(pages, "Udon", { include: "limits-and-quirks.md", maxMatches: 5 });
  check(
    "include: 单文件收窄生效",
    narrowed.ok && narrowed.matches.every((m) => m.path.endsWith("limits-and-quirks.md")),
    narrowed.ok ? narrowed.text.split("\n")[0] : narrowed.text,
  );
  const brace = mod.grepPages(pages, "Udon", { include: "{index,limits-and-quirks}.md", maxMatches: 5 });
  check(
    "include 支持 {a,b}",
    brace.ok && brace.matches.every((m) => /\/(index|limits-and-quirks)\.md$/.test(m.path)),
    brace.ok ? `paths: ${[...new Set(brace.matches.map((m) => m.path))].join(", ")}` : brace.text,
  );

  // ── chain: grep → read ──────────────────────────────────────────────────
  const hit = mod.grepPages(pages, "RULE-LL-12", { maxMatches: 1 });
  const firstMatch = hit.matches?.[0];
  const near = mod.readPage(pages, firstMatch.path, Math.max(1, firstMatch.lineNumber - 2), 5);
  check("grep 结果直接喂给 read", near.ok, near.text.split("\n").slice(0, 2).join(" | "));

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
