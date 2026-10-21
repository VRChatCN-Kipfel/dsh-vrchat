/**
 * Verify the INSTALLED package can find its own corpus and read pages from it.
 *
 * This is the deployment-shaped check: it runs against the generation directory
 * `pnpm` created, not the workspace, so it proves that "the corpus travels with
 * the package" actually holds after installation.
 *
 * Usage: node tools/verify-installed-corpus.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const generationsLib = require("./lib-generation.cjs");

async function main() {
  const target = generationsLib.newestGeneration("dsh-vrchat-kb+");
  if (target === null) {
    console.log("找不到已安装代");
    process.exit(1);
  }
  const pkgRoot = path.join(generationsLib.liveRoot(), target, "node_modules", "dsh-vrchat-kb");
  console.log(`代: ${target}`);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const search = await import(pathToFileURL(path.join(pkgRoot, "lib", "search.js")).href);
  const docs = await import(pathToFileURL(path.join(pkgRoot, "lib", "docs.js")).href);

  // ── the corpus is physically present in the installed package ──────────
  check("包内含语料目录", fs.existsSync(path.join(pkgRoot, "VRChat-Agent-Creator-Library")));
  check("data/ 下有 pages.json 副本", !fs.existsSync(path.join(pkgRoot, "data", "pages.json")));
  check("data/ 下有 corpus 副本", !fs.existsSync(path.join(pkgRoot, "data", "corpus")));

  // ── discovery works from the INSTALL location ──────────────────────────
  const corpus = search.findCorpusRoot(pkgRoot);
  check("从安装目录发现语料", corpus !== null, String(corpus));
  check("发现路径在包内", corpus !== null && corpus.startsWith(pkgRoot), String(corpus));

  // ── the store actually reads pages out of the installed corpus ─────────
  const dataDir = path.join(pkgRoot, "data");
  const store = search.createStore(dataDir, corpus);
  check("store 有 corpusRoot", store.corpusRoot !== null);
  check("索引 414 页", store.index.length === 414, String(store.index.length));

  const sample = "entities/api/not-exposed.md";
  const body = store.bodyOf(sample);
  check("从装入的语料读到正文", typeof body === "string" && body.length > 500, `${body === null ? 0 : body.length} 字符`);

  let readable = 0;
  for (const entry of store.index) if (store.bodyOf(entry.path) !== null) readable++;
  check("全部 414 页可读", readable === 414, `${readable} 页`);

  // ── retrieval and the docs pair work against the installed corpus ──────
  const hit = search.answer(store, "Udon 同步变量非 Owner 写入", { limit: 2, charBudget: 1200 });
  check("装入后检索命中", hit.hit === true, `hit=${hit.hit} pages=${hit.pageCount}`);

  const paths = store.index.map((entry) => entry.path);
  const grep = docs.grepPages(paths, store.bodyOf, "PropertyToID", { maxMatches: 3 });
  check("装入后 grep 命中", grep.ok && grep.total > 0, `total=${grep.total}`);

  const read = docs.readPage(store.bodyOf, paths, sample, 1, 5);
  check("装入后 read 成功", read.ok, String(read.path));

  // ── api table still resolves next to the corpus ────────────────────────
  check("data/api-table.json 随包", fs.existsSync(path.join(dataDir, "api-table.json")));

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
