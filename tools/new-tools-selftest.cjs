/**
 * Exercise the two new tools end to end, offline.
 *
 * Usage: node tools/new-tools-selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = path.join(__dirname, "..");
  const mod = await import(pathToFileURL(path.join(root, "lib", "metadata.js")).href);
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);

  const meta = JSON.parse(fs.readFileSync(path.join(root, "data", "manifest.json"), "utf8"));
  const store = search.createStore(path.join(root, "data"), search.findCorpusRoot(root));

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── vrchat_kb_filter semantics ──────────────────────────────────────────
  const deprecated = mod.filterIndex(store.index, { status: "deprecated" });
  check("能筛出 deprecated 页", deprecated.length === 1, deprecated[0]?.path ?? "none");
  check("deprecated 页有路径", typeof deprecated[0]?.path === "string");

  const questHigh = mod.filterIndex(store.index, { category: "platform", confidence: "high" });
  check("平台域 + high 可信度可组合", questHigh.length > 0, `${questHigh.length} 页`);

  const withTags = mod.filterIndex(store.index, { tags: ["quest"] });
  check("按标签筛 quest 有结果", withTags.length > 0, `${withTags.length} 页`);
  check("结果都含 quest 标签", withTags.every((entry) => entry.tags.includes("quest")));

  // The critical property: a typo must not look like "everything matches".
  const typo = mod.validateFilters({ cateogry: "world" });
  check("拼错 category 被拒绝", typo !== null);
  check("拒绝时列出正确字段名", /category/.test(typo ?? ""), typo ?? "");

  // ── vrchat_kb_list ─────────────────────────────────────────────────────
  const described = mod.describeLibraries({
    manifest: meta,
    index: store.index,
    corpusRoot: store.corpusRoot,
    dataDir: path.join(root, "data"),
  });
  check("列出 1 个库", /已加载 1 个知识库/.test(described));
  // Compare against the index under test, not a literal: a hardcoded count
  // measures the submodule revision, so every upstream page addition turns this
  // red while the code is fine.
  check(
    "描述给出的页数与索引一致",
    described.includes(`页数：${store.index.length}`),
    `期望 页数：${store.index.length}`,
  );
  check("给出分类分布且含 world 计数", /world/.test(described) && /\b202\b/.test(described));
  check("给出 draft/deprecated 提醒", /deprecated 1 页/.test(described));
  check("不泄漏本机绝对路径", !/[A-Za-z]:[\\/]/.test(described));
  check("不泄漏语料目录段", !/LLMWikiPage|memoryV\d/.test(described), "只给上游相对描述");

  // ── both tools must degrade, not crash, without a corpus ───────────────
  const bare = search.createStore(path.join(root, "data"), null);
  const bareList = mod.describeLibraries({ manifest: meta, index: bare.index, corpusRoot: bare.corpusRoot, dataDir: "" });
  check("无语料时 list 说 0 个库", /已加载 0 个知识库/.test(bareList));
  check("无语料时 list 给出原因", /缺少自带语料目录/.test(bareList));
  check("无语料时 filter 的索引仍可用", bare.index.length > 0, `${bare.index.length} 页`);

  // ── paths returned must be library-relative ────────────────────────────
  const paths = mod.filterIndex(store.index, { category: "world" }).slice(0, 50).map((e) => e.path);
  check(
    "返回的路径都是库内相对",
    paths.every((p) => !path.isAbsolute(p) && !p.includes("node_modules") && !/^[A-Za-z]:/.test(p)),
    paths.slice(0, 2).join(", "),
  );

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
