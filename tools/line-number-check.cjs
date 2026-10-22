/**
 * Verify line numbers are NOT renumbered when frontmatter is skipped.
 *
 * The design chose "skip the metadata, keep the file's own line numbers". That
 * only works if the numbers really are the file's own — if the window were
 * renumbered from 1, a grep hit at line 240 could no longer be read back with
 * offset=240, and the grep → read chain the pair exists for would break.
 *
 * This measures it instead of trusting the comment.
 *
 * Usage: node tools/line-number-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = path.join(__dirname, "..");
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);

  const corpus = search.findCorpusRoot(root);
  const store = search.createStore(path.join(root, "data"), corpus);
  const paths = store.index.map((entry) => entry.path);
  const sample = "entities/world/udon/networking/variables.md";

  const raw = fs.readFileSync(path.join(corpus, ...sample.split("/")), "utf8");
  // Compare against the NORMALIZED text, which is what the store serves: the
  // corpus is CRLF on disk and the store strips the carriage returns. Line COUNT
  // is unaffected (measured 484 vs 484), so numbers still match an editor.
  const fileLines = raw.replace(/\r\n/g, "\n").split("\n");

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── default read starts at the prose, not at line 1 ─────────────────────
  const def = docs.readPage(store.bodyOf, paths, sample);
  check("默认读取成功", def.ok, String(def.path));
  check("默认读取跳过 frontmatter", def.offset > 1, `从第 ${def.offset} 行开始`);
  check("默认首行不是 YAML 分隔符", def.lines[0].text.trim() !== "---", def.lines[0].text.slice(0, 40));

  // ── the numbers ARE the file's own ──────────────────────────────────────
  let mismatches = 0;
  for (const line of def.lines) {
    if (fileLines[line.number - 1] !== line.text) mismatches++;
  }
  check(
    "行号与文件实际行一一对应（未重新编号）",
    mismatches === 0,
    `${def.lines.length} 行中 ${mismatches} 行对不上`,
  );

  // The first served line must equal the file line at its stated number.
  check(
    "首行号指向文件真实内容",
    def.lines[0].text === fileLines[def.offset - 1],
    `第 ${def.offset} 行`,
  );

  // ── explicit offset is honoured verbatim, so grep chains ────────────────
  const explicit = docs.readPage(store.bodyOf, paths, sample, 240, 3);
  check("显式 offset 被原样采用", explicit.offset === 240, String(explicit.offset));
  check(
    "显式 offset 取到的是该行原文",
    explicit.lines[0].text === fileLines[239],
    explicit.lines[0].text.slice(0, 40),
  );
  check("显式 offset 不追加跳过提示", !/Skipped lines/.test(explicit.text));

  // ── asking for offset=1 does return the metadata, deliberately ──────────
  const head = docs.readPage(store.bodyOf, paths, sample, 1, 3);
  check("offset=1 可读 frontmatter", head.lines[0].text.trim() === "---", head.lines[0].text);
  check("offset=1 不追加跳过提示", !/Skipped lines/.test(head.text));

  // ── the skip is declared, so nothing looks missing silently ────────────
  check("默认读取声明跳过了多少行", /Skipped lines 1-\d+ of YAML metadata/.test(def.text));

  // ── grep → read chaining on a real hit ─────────────────────────────────
  const grep = docs.grepPages(paths, store.bodyOf, "RequestSerialization", { maxMatches: 1 });
  check("grep 有命中", grep.ok && grep.matches.length > 0, `total=${grep.total}`);
  if (grep.ok && grep.matches.length > 0) {
    const hit = grep.matches[0];
    const around = docs.readPage(store.bodyOf, paths, hit.path, hit.lineNumber, 1);
    check(
      `grep 行号能直接读回同一行（${hit.path}:${hit.lineNumber}）`,
      around.ok && around.lines[0].text.includes("RequestSerialization"),
      around.ok ? around.lines[0].text.slice(0, 60) : around.text,
    );
  }

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
