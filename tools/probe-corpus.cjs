/**
 * Verify corpus discovery: declared INSIDE the package, adaptive OUTSIDE it.
 *
 * - Inside: the corpus path is this library's own layout (`CORPUS_ENTRY`), so a
 *   sibling library with a different layout cannot be picked up by accident.
 * - Outside: the package root is supplied by the caller, so wherever npm/pnpm
 *   installed the module is where the search starts.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "search.js")).href);
  const root = path.join(__dirname, "..");

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const started = Date.now();
  const found = mod.findCorpusRoot(root);
  const elapsed = Date.now() - started;

  check("从工作区包根找到语料", found !== null, String(found));
  check("发现耗时极低（声明路径，非扫描）", elapsed < 20, `${elapsed} ms`);
  check("路径等于声明的 entry", found === path.join(root, ...mod.CORPUS_ENTRY), String(found));

  if (found !== null) {
    const pages = fs.readdirSync(found, { withFileTypes: true });
    check("含 entities 域", pages.some((e) => e.name === "entities" && e.isDirectory()));
    const mdCount = (function walk(dir, n = 0) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) n = walk(full, n);
        else if (entry.name.endsWith(".md")) n++;
      }
      return n;
    })(found, 0);
    check("含 414 个 markdown 页", mdCount === 414, `${mdCount} 页`);
  }

  check("空包根返回 null", mod.findCorpusRoot("") === null);
  check("不存在的包根返回 null", mod.findCorpusRoot("Z:/definitely/not/here") === null);

  // A package root that exists but carries no corpus must also return null —
  // that is the "submodule not checked out" case.
  check("无语料的包根返回 null", mod.findCorpusRoot(path.join(root, "lib")) === null);

  // Entry is a parameter, so a sibling library declares its own layout.
  const sibling = mod.findCorpusRoot(root, ["VRChat-Agent-Creator-Library", "memoryV5.0.0", "LLMWikiExample", "LLMWikiPage"]);
  check("显式 entry 可用（多库各声明自己的）", sibling === found, String(sibling));

  // The corpus must NOT live inside the derived-data directory: bodies are body,
  // derived artifacts are index.
  check("data/ 下没有语料副本", !fs.existsSync(path.join(root, "data", "corpus")));

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main();
