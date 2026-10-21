/**
 * Offline self-test for the KB retrieval logic — runs without the Harness.
 *
 * Usage: node tools/selftest.cjs [query...]
 * Prints the routing decision and the composed answer for each query, plus a
 * data-integrity check. Doubles as the regression test after a corpus rebuild.
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

const dataDir = join(__dirname, "..", "data");

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "search.js")).href);

  // ── integrity ────────────────────────────────────────────────────────────
  const index = JSON.parse(fs.readFileSync(join(dataDir, "index.json"), "utf8"));
  const routes = JSON.parse(fs.readFileSync(join(dataDir, "keyword-routes.json"), "utf8"));
  const pages = JSON.parse(fs.readFileSync(join(dataDir, "pages.json"), "utf8"));

  const missing = index.filter((entry) => pages[entry.path] === undefined);
  const emptyRoutes = routes.filter((route) => route.keywords.length === 0);
  console.log(`pages indexed : ${index.length}`);
  console.log(`bodies present: ${Object.keys(pages).length}`);
  console.log(`missing bodies: ${missing.length}${missing.length > 0 ? " -> " + missing.slice(0, 3).map((m) => m.path).join(", ") : ""}`);
  console.log(`keyword routes: ${routes.length} (empty: ${emptyRoutes.length})`);
  const conf = index.reduce((acc, entry) => {
    const k = entry.confidence ?? "unset";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`confidence    : ${JSON.stringify(conf)}`);
  console.log("");

  const store = mod.createStore(dataDir);

  const queries =
    process.argv.length > 2
      ? process.argv.slice(2)
      : [
          "Udon 同步变量 非 Owner 写入会怎样",
          "physbone 性能上限是多少",
          "poiyomi quest 用哪个变体",
          "persistence 玩家数据 100KB",
          "我自己写了一个 Rust CI 流水线", // 必须空结果 + 范围地图
        ];

  for (const query of queries) {
    const routed = mod.matchRoutes(store, query);
    const { scored } = mod.rank(store, query);
    console.log("=".repeat(78));
    console.log(`QUERY: ${query}`);
    console.log(`routes: ${routed.length === 0 ? "(none)" : routed.map((r) => r.concept + " -> " + r.target).join(" | ")}`);
    console.log(`hits  : ${scored.length} page(s)`);
    const text = mod.answer(store, query, { limit: 3, excerptBudget: 1200 });
    console.log("-".repeat(78));
    console.log(text);
    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
