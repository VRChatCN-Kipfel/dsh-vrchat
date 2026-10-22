/**
 * Guard the path contract: paths are LIBRARY-RELATIVE, and nothing else.
 *
 * The corpus location is the plugin's own business. The tools resolve it
 * internally, so the agent never needs to know where the files sit — not the
 * install directory, not the submodule name, not the versioned folder. `docs.js`
 * once translated absolute install paths, which quietly taught the opposite: that
 * the agent is expected to know our filesystem. It also broke the moment the
 * package moved.
 *
 * This check pins the contract from both directions:
 *   · what a caller may pass in
 *   · that `grep` output feeds `read` directly, so no path reasoning is needed
 *
 * Usage: node tools/path-contract-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = path.join(__dirname, "..");
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);

  const store = search.createStore(path.join(root, "data"), search.findCorpusRoot(root));
  const paths = store.index.map((entry) => entry.path);
  const sample = "entities/api/not-exposed.md";

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── accepted forms: library-relative conventions an agent already has ────
  check("库内相对路径", docs.resolvePage(paths, sample) === sample);
  check("省略 .md", docs.resolvePage(paths, "entities/api/not-exposed") === sample);
  check("前导 ./", docs.resolvePage(paths, `./${sample}`) === sample);
  check("前导 /（视为库根）", docs.resolvePage(paths, `/${sample}`) === sample);
  check("反斜杠归一", docs.resolvePage(paths, "entities\\api\\not-exposed.md") === sample);
  check("唯一 bare basename", docs.resolvePage(paths, "not-exposed.md") === sample);

  // ── rejected: anything that reveals the corpus location ──────────────────
  //
  // These must resolve to null. Resolving them would imply the agent should know
  // the install layout, and would break when the package is installed elsewhere.
  const mustNotResolve = {
    "Windows 绝对路径": `D:/x/VRChat-Agent-Creator-Library/memoryV5.0.0/LLMWikiExample/LLMWikiPage/${sample}`,
    "Unix 绝对路径": `/home/x/lib/memoryV5.0.0/LLMWikiExample/LLMWikiPage/${sample}`,
    "安装目录相对路径": `node_modules/dsh-vrchat-kb/VRChat-Agent-Creator-Library/${sample}`,
    "版本目录段": `memoryV5.0.0/LLMWikiExample/LLMWikiPage/${sample}`,
  };
  for (const [label, candidate] of Object.entries(mustNotResolve)) {
    check(`拒绝 ${label}`, docs.resolvePage(paths, candidate) === null, candidate.slice(0, 60));
  }

  // ── docs.js must not name the corpus layout at all ───────────────────────
  const raw = fs.readFileSync(path.join(root, "lib", "docs.js"), "utf8");
  // Strip comments first: explaining why we do NOT translate is fine.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  check("docs.js 代码不提及语料目录名", !/LLMWikiPage|memoryV\d|VRChat-Agent-Creator-Library/.test(code));

  // Documentation counts too: a comment claiming "absolute paths are translated"
  // describes behaviour that no longer exists, and the next reader will trust it.
  const claimsTranslation = /(绝对路径|absolute path).{0,60}(被换算|translated|会被换算)/i.test(raw);
  check(
    "docs.js 注释不再声称会翻译绝对路径",
    !claimsTranslation,
    "文档说反了，后来的人会照着实现回去",
  );

  // ── grep output feeds read with no transformation ───────────────────────
  const grep = docs.grepPages(paths, store.bodyOf, "PropertyToID", { maxMatches: 3 });
  check("grep 有命中", grep.ok && grep.matches.length > 0, `total=${grep.total}`);

  let fed = 0;
  for (const match of grep.matches) {
    check(`grep 路径是库内相对形式（${match.path}）`, !path.isAbsolute(match.path) && match.path.endsWith(".md"));
    const read = docs.readPage(store.bodyOf, paths, match.path, match.lineNumber, 3);
    if (read.ok) fed++;
  }
  check("grep 的每条路径都能原样喂给 read", fed === grep.matches.length, `${fed}/${grep.matches.length}`);

  // ── the failure message must point at the tool, not at a path ────────────
  const failed = docs.readPage(store.bodyOf, paths, "no/such.md");
  check("失败时提示用 grep 取库内路径", /Use vrchat_kb_grep to find the library path/.test(failed.text), failed.text);
  check("失败时不提安装目录或绝对路径", !/install|absolute|node_modules/i.test(failed.text));

  // ── NO tool output may reveal this machine's layout ─────────────────────
  //
  // `read` and `grep` were the obvious suspects, but the digest, the API lookup
  // and the scan report all reach the model too. Sweep every one: a path that
  // reveals the install directory is a defect even when it is only cosmetic.
  const apiTable = await import(pathToFileURL(path.join(root, "lib", "api-table.js")).href);
  const lint = await import(pathToFileURL(path.join(root, "lib", "lint.js")).href);
  const table = JSON.parse(fs.readFileSync(path.join(root, "data", "api-table.json"), "utf8"));
  const apiIndex = apiTable.buildIndex({
    types: (table.types ?? []).map((type) => ({
      ...type,
      members: (type.members ?? []).map((member) => ({ raw: member.raw, name: member.name, kind: member.kind, params: [] })),
    })),
  });

  const surfaces = {
    "vrchat_kb（命中）": search.answer(store, "Udon 同步变量", { limit: 2, charBudget: 1500 }).text,
    "vrchat_kb（未命中）": search.answer(store, "今天天气", { limit: 2 }).text,
    "vrchat_kb_grep": docs.grepPages(paths, store.bodyOf, "PropertyToID", { maxMatches: 2 }).text,
    "vrchat_kb_read": docs.readPage(store.bodyOf, paths, sample, 1, 3).text,
    "vrchat_kb_read（失败）": failed.text,
    "vrchat_kb_api": JSON.stringify(apiTable.lookup(apiIndex, "Transform")).slice(0, 800),
    "vrchat_kb_scan": JSON.stringify(lint.lintSource("x.cs", "List<int> a;")),
  };

  // The two metadata tools are new output surfaces; they must obey the same rule.
  const metadata = await import(pathToFileURL(path.join(root, "lib", "metadata.js")).href);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "manifest.json"), "utf8"));
  surfaces["vrchat_kb_list"] = metadata.describeLibraries({
    manifest,
    index: store.index,
    corpusRoot: store.corpusRoot,
    dataDir: path.join(root, "data"),
  });
  const filtered = metadata.filterIndex(store.index, { category: "world", confidence: "high" });
  surfaces["vrchat_kb_filter"] = filtered.map((entry) => `${entry.path}\t${entry.title}`).join("\n");

  /** Install-path markers. A public repo name in provenance is NOT a leak. */
  const installMarkers = {
    "Windows 盘符": /[A-Za-z]:[\\/]/,
    "Unix 家目录": /(^|\s)\/(home|Users|usr|opt|var)\//,
    "node_modules": /node_modules[/\\]/,
    "文件系统漫游": /(?:^|[\s(])(?:\.{1,2}[\\/]|~[\\/])/,
    // Our own corpus layout is install state, not something the agent should learn.
    "语料目录段": /LLMWikiPage|memoryV\d/,
  };

  for (const [label, text] of Object.entries(surfaces)) {
    const found = Object.entries(installMarkers)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => name);
    check(`${label} 不泄漏本机路径`, found.length === 0, found.join(", ") || "none");
  }

  // Every .md reference that DOES appear must be library-relative.
  for (const [label, text] of Object.entries(surfaces)) {
    const refs = [...new Set([...text.matchAll(/[\w\-./]+\.md/g)].map((match) => match[0]))];
    const bad = refs.filter((ref) => ref.startsWith("/") || /^[A-Za-z]:/.test(ref) || ref.includes("node_modules"));
    check(`${label} 的 md 引用都是库内相对`, bad.length === 0, bad.join(", ") || `${refs.length} 条`);
  }

  // Provenance naming the public upstream repo is correct, so pin it: removing it
  // would lose attribution, and it must not be confused with a local path.
  const coverageText = surfaces["vrchat_kb（未命中）"];
  check(
    "未命中文案标明公开上游出处（不是本机路径）",
    /RhineLab-magellan|VRChat-Agent-Creator-Library/.test(coverageText),
    "出处是公开仓库名，可与本机路径共存无歧义",
  );

  let failCount = 0;
  for (const item of checks) {
    if (!item.ok) failCount++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failCount === 0 ? `全部 ${checks.length} 条通过` : `${failCount} / ${checks.length} 条未通过`);
  if (failCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
