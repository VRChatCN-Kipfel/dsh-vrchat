/**
 * Offline self-test for the KB retrieval logic.
 *
 * The corpus is NO LONGER shipped in the bundle: page bodies are read lazily
 * from the sibling submodule checkout. This test therefore exercises both the
 * corpus-backed store and the degraded store, because "this workspace has no
 * submodule" is a real deployment that must degrade visibly, not silently.
 *
 * Usage: node tools/selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");

async function main() {
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── corpus discovery: declared inside, adaptive outside ────────────────
  const found = search.findCorpusRoot(root);
  check("从包根找到语料", found !== null, String(found));
  check("路径等于声明的 entry", found === path.join(root, ...search.CORPUS_ENTRY));
  check("空路径安全", search.findCorpusRoot("") === null);
  check("不存在的路径安全", search.findCorpusRoot("Z:/definitely/not/here") === null);
  check("无 corpus 的包根返回 null", search.findCorpusRoot(path.join(root, "lib")) === null);
  check("data/ 下没有语料副本", !fs.existsSync(path.join(dataDir, "corpus")));

  // ── shipped index must stay intact WITHOUT the corpus ──────────────────
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
  // The page count is NOT asserted against a literal. The upstream corpus is a
  // submodule that gains pages (this check failed the day a 415th page landed), and
  // a hardcoded number turns every upstream update into a red build that says
  // nothing about whether the index is actually correct. What matters is that the
  // index is non-empty and complete relative to itself, which the readability check
  // below already proves page by page.
  check("index.json 非空", index.length > 0, `${index.length} 页`);
  check("index.json 不携带正文", !Object.hasOwn(index[0], "body"));
  const conf = index.reduce((acc, entry) => {
    const key = entry.confidence ?? "unset";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  // Likewise: the exact high/medium split moves whenever upstream reviews a page.
  // Assert that the confidence field survived the build and covers every page.
  check(
    "每页都有 confidence",
    (conf.high ?? 0) + (conf.medium ?? 0) + (conf.low ?? 0) === index.length,
    JSON.stringify(conf),
  );

  // ── store WITH the corpus ───────────────────────────────────────────────
  const store = search.createStore(dataDir, found);
  check("store 记住 corpusRoot", store.corpusRoot === found);

  const sample = index[0].path;
  const body = store.bodyOf(sample);
  check("惰性读到正文", typeof body === "string" && body.length > 0, `${body === null ? 0 : body.length} 字符`);
  check("重复读命中缓存", store.bodyOf(sample) === body);
  check("缺失页返回 null 而非抛错", store.bodyOf("no/such/page.md") === null);

  let readable = 0;
  for (const entry of index) if (store.bodyOf(entry.path) !== null) readable++;
  // Every indexed page must be readable — expressed as a comparison, not a literal,
  // for the same reason as above.
  check("索引里每一页都可读", readable === index.length, `${readable}/${index.length} 页`);

  // ── store WITHOUT the corpus: degrade, never throw ─────────────────────
  const bare = search.createStore(dataDir, null);
  check("无语料时 store 可用", bare.corpusRoot === null);
  check("无语料时读页返回 null", bare.bodyOf(index[0].path) === null);

  const bareAnswer = search.answer(bare, "Udon 同步变量");
  check("无语料时 answer 不抛错", typeof bareAnswer.text === "string");
  check("无语料时标为未命中", bareAnswer.hit === false, String(bareAnswer.pageCount));

  const paths = index.map((entry) => entry.path);
  const bareGrep = docs.grepPages(paths, bare.bodyOf, "Udon");
  check("无语料时 grep 不抛错", typeof bareGrep.text === "string");
  check(
    "无语料时 grep 说明语料缺失而非无匹配",
    /corpus checkout is missing|unavailable/.test(bareGrep.text),
    bareGrep.text.slice(0, 80),
  );

  const bareRead = docs.readPage(bare.bodyOf, paths, index[0].path);
  check("无语料时 read 不抛错", typeof bareRead.text === "string");
  check("无语料时 read 说明正文不可用", /unavailable/.test(bareRead.text), bareRead.text.slice(0, 80));

  // ── retrieval behaviour (unchanged by the storage change) ──────────────
  const cases = [
    { query: "Udon 同步变量非 Owner 写入会怎样", expect: true },
    { query: "physbone 性能上限是多少", expect: true },
    { query: "poiyomi quest 用哪个变体", expect: true },
    { query: "persistence 玩家数据 100KB", expect: true },
    { query: "我自己写了一个 Rust CI 流水线", expect: false },
    { query: "今天天气怎么样", expect: false },
  ];
  for (const item of cases) {
    const result = search.answer(store, item.query, { limit: 3, charBudget: 1200 });
    check(
      `检索「${item.query}」${item.expect ? "应命中" : "应空"}`,
      result.hit === item.expect,
      `hit=${result.hit} pages=${result.pageCount}`,
    );
  }

  const empty = search.answer(store, "我自己写了一个 Rust CI 流水线");
  check("空结果带覆盖边界", /覆盖|不覆盖/.test(empty.text));
  check("空结果提示不要重复检索", /不要重复检索/.test(empty.text));

  // ── docs tools against the real corpus ─────────────────────────────────
  const grep = docs.grepPages(paths, store.bodyOf, "PropertyToID", { maxMatches: 5 });
  check("真实语料 grep 命中", grep.ok && grep.total > 0, `total=${grep.total}`);
  check("grep 输出带行号", /Line \d+:/.test(grep.text));

  const read = docs.readPage(store.bodyOf, paths, "entities/api/not-exposed.md", 1, 5);
  check("真实语料 read 成功", read.ok, String(read.path));
  check("read 输出官方式脚注", /Showing lines 1-5 of \d+/.test(read.text), read.text.split("\n").at(-1));

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
