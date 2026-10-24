/**
 * Debug one query's tokenization, coverage and routing — the numbers that decide
 * whether the coverage-boundary fallback fires.
 *
 * Usage: node tools/debug-query.cjs "some query"
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const STOP = new Set([
  "会怎", "怎样", "怎么", "什么", "多少", "如何", "哪一", "一个", "这个", "那个",
  "可以", "是否", "需要", "自己", "我的", "我们", "请问", "应该", "用的", "用哪",
]);

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "search.js")).href);
  // The corpus root is NOT optional here. `createStore(dataDir)` defaults it to
  // null, and with no root `bodyOf()` returns null for every page — so every
  // haystack is just "title + tags", and `rank()` can only admit a page whose
  // TITLE or TAGS cover a query token. Body-only matches, which is most of the
  // corpus, are invisible. That made this probe report a false "0 hits" for
  // questions the real tool answers: `blender` scored 0 here and 13 with the
  // corpus attached, because only the body names it for the other 12 pages.
  //
  // This is the same resolution the shipped plugin uses, so the probe now
  // measures what a session measures.
  const corpusRoot = mod.findCorpusRoot(join(__dirname, ".."));
  if (corpusRoot === null) {
    console.error("找不到语料根：debug-query 需要随包语料才能得到真实数字，否则结果是假阴性。");
    process.exit(2);
  }
  const store = mod.createStore(join(__dirname, "..", "data"), corpusRoot);
  const query = process.argv[2] ?? "我自己写了一个 Rust CI 流水线";

  console.log(`corpus : ${corpusRoot}`);
  const raw = mod.tokenize(query);
  const kept = raw.filter((t) => !STOP.has(t));
  console.log(`query  : ${query}`);
  console.log(`raw    : ${JSON.stringify(raw)}`);
  console.log(`kept   : ${JSON.stringify(kept)}   (stopword-dropped: ${JSON.stringify(raw.filter((t) => STOP.has(t)))})`);

  const routed = mod.matchRoutes(store, query);
  console.log(`routes : ${routed.length === 0 ? "(none)" : routed.map((r) => r.concept).join(" | ")}`);

  const { scored, tokens } = mod.rank(store, query);
  console.log(`tokens used by rank: ${JSON.stringify(tokens)}`);
  console.log(`admitted pages: ${scored.length}`);
  for (const item of scored.slice(0, 6)) {
    console.log(`  coverage=${item.coverage.toFixed(2)}  score=${String(item.score).padStart(3)}  ${item.entry.path}`);
  }

  const result = mod.answer(store, query, { limit: 3, charBudget: 1200 });
  console.log(`answer.hit = ${result.hit}  pageCount = ${result.pageCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
