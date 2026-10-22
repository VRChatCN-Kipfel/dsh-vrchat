/**
 * Offline self-test for structured filtering and library description.
 *
 * Usage: node tools/metadata-selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = path.join(__dirname, "..");
  const mod = await import(pathToFileURL(path.join(root, "lib", "metadata.js")).href);
  const meta = JSON.parse(fs.readFileSync(path.join(root, "data", "manifest.json"), "utf8"));
  const index = JSON.parse(fs.readFileSync(path.join(root, "data", "index.json"), "utf8"));

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── field validation ────────────────────────────────────────────────────
  check("已知字段通过校验", mod.validateFilters({ confidence: "high" }) === null);
  check("多个已知字段通过", mod.validateFilters({ confidence: "high", category: "world" }) === null);
  check("tags 是已知字段", mod.validateFilters({ tags: ["sync"] }) === null);
  check("title / path 是已知字段", mod.validateFilters({ title: "udon", path: "entities" }) === null);

  const typo = mod.validateFilters({ confidance: "high" });
  check("拼错字段被拒绝（不静默返回全部）", typo !== null && /confidance/.test(typo), typo ?? "");
  check("拒绝信息列出已知字段", /Known:/.test(typo ?? ""));
  check("非对象被拒绝", mod.validateFilters(null) !== null);

  // ── filtering ───────────────────────────────────────────────────────────
  const all = mod.filterIndex(index, {});
  check("空筛选返回全部", all.length === index.length, String(all.length));

  const high = mod.filterIndex(index, { confidence: "high" });
  check("confidence=high 计数正确", high.length === 204, String(high.length));
  check("结果每项都符合条件", high.every((entry) => entry.confidence === "high"));

  const world = mod.filterIndex(index, { category: "world" });
  check("category=world 计数正确", world.length === 202, String(world.length));

  const both = mod.filterIndex(index, { confidence: "high", category: "world" });
  check("组合筛选是 AND", both.length === 82, String(both.length));
  check("组合结果是两个集合的交集", both.length < Math.min(high.length, world.length));

  // Case insensitivity: the frontmatter is inconsistent (`High` and `high`).
  check("标量字段大小写不敏感", mod.filterIndex(index, { confidence: "HIGH" }).length === high.length);

  const deprecated = mod.filterIndex(index, { status: "deprecated" });
  check("status=deprecated 精确命中 1 页", deprecated.length === 1, String(deprecated.length));
  const draft = mod.filterIndex(index, { status: "draft" });
  check("status=draft 精确命中 1 页", draft.length === 1, String(draft.length));

  // Tags: ALL requested must be present.
  const sync = mod.filterIndex(index, { tags: ["sync"] });
  check("tags=[sync] 有结果", sync.length > 0, String(sync.length));
  check("结果都含该标签", sync.every((entry) => entry.tags.includes("sync")));

  const two = mod.filterIndex(index, { tags: ["sync", "performance"] });
  check("多个标签要求全部命中", two.every((entry) => entry.tags.includes("sync") && entry.tags.includes("performance")));
  check("多标签结果不多于单标签", two.length <= sync.length, `${two.length} ≤ ${sync.length}`);

  check("不存在的标签返回空", mod.filterIndex(index, { tags: ["zzz-not-a-tag"] }).length === 0);

  // Text fields.
  const titleHit = mod.filterIndex(index, { title: "udon" });
  check("title 子串匹配", titleHit.length > 0 && titleHit.every((entry) => entry.title.toLowerCase().includes("udon")));

  const pathHit = mod.filterIndex(index, { path: "entities/api" });
  check("path 子串匹配", pathHit.length > 0 && pathHit.every((entry) => entry.path.startsWith("entities/api")));

  // ── facets ──────────────────────────────────────────────────────────────
  const cats = mod.facet(index, "category");
  check("facet 覆盖全部条目", cats.reduce((sum, [, n]) => sum + n, 0) === index.length);
  check("facet 按计数降序", cats.every((entry, i) => i === 0 || cats[i - 1][1] >= entry[1]));
  check("facet 的 world 计数正确", cats.find(([v]) => v === "world")?.[1] === 202);

  const tags = mod.facet(index, "tags");
  check("tags facet 有 372 个标签", tags.length === 372, String(tags.length));

  // ── library description ─────────────────────────────────────────────────
  const described = mod.describeLibraries({
    manifest: meta,
    index,
    corpusRoot: path.join(root, "VRChat-Agent-Creator-Library"),
    dataDir: path.join(root, "data"),
  });
  check("描述列出库数", /已加载 1 个知识库/.test(described));
  check("描述给出页数", /页数：414/.test(described));
  check("描述给出分类分布", /world/.test(described) && /202/.test(described));
  check("描述给出可信度分布", /high 204/.test(described));
  check("描述提示 draft/deprecated", /draft 1 页 \/ deprecated 1 页/.test(described));
  check("描述不含本机绝对路径", !/[A-Za-z]:[\\/]/.test(described));

  const empty = mod.describeLibraries({ manifest: meta, index, corpusRoot: null, dataDir: "" });
  check("无语料时说明 0 个库", /已加载 0 个知识库/.test(empty));
  check("无语料时给出原因", /缺少自带语料目录/.test(empty));

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
