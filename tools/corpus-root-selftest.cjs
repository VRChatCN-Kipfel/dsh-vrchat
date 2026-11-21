/**
 * Self-test for `lib/corpus-root.cjs` — the "which knowledge root" rule.
 *
 * WHY THIS FILE EXISTS. The resolver decides which directory the plugin answers
 * from, and it now applies a RULE (newest `memoryV*` wins) instead of naming one
 * literal. A rule needs adversarial tests, because its failure mode is not a
 * crash but a plausible answer from the wrong directory:
 *
 *   · lexicographic ordering would rank 5.0.9 above 5.0.10;
 *   · a silent fallback would serve last release's pages from a stale checkout;
 *   · a wildcard that escapes the submodule could adopt another library's corpus;
 *   · a half-checked-out directory would read as "a corpus with zero pages".
 *
 * Every fixture below exercises one of those, and the real-repo assertions are
 * cross-checked against TWO independent oracles — a differently-implemented
 * directory scan (`lib-corpus-oracle.cjs`) and git's own tree metadata — never
 * against the resolver's own return value.
 *
 * Usage: node tools/corpus-root-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const resolver = require("../lib/corpus-root.cjs");
const oracle = require("./lib-corpus-oracle.cjs");

const root = path.join(__dirname, "..");
const SUBMODULE = "VRChat-Agent-Creator-Library";

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? "" });
const skip = (name, reason) => checks.push({ name, ok: true, skipped: true, detail: reason });

/**
 * Build a corpus-shaped tree: `<base>/<dir>/LLMWikiExample/LLMWikiPage/entities/`.
 *
 * `entities/` is what recognition looks for, so a fixture without it is a
 * half-checked-out submodule on purpose.
 */
function plant(base, dir, { entities = true } = {}) {
  const pageRoot = path.join(base, SUBMODULE, dir, "LLMWikiExample", "LLMWikiPage");
  fs.mkdirSync(pageRoot, { recursive: true });
  if (entities) fs.mkdirSync(path.join(pageRoot, "entities"), { recursive: true });
  return pageRoot;
}

const tmpRoots = [];
function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-corpus-root-"));
  fs.mkdirSync(path.join(dir, SUBMODULE), { recursive: true });
  tmpRoots.push(dir);
  return dir;
}

/** Path the resolver must produce for `base` + version dir. */
function expected(base, dir) {
  return path.join(base, SUBMODULE, dir, "LLMWikiExample", "LLMWikiPage");
}

// ── 1. numeric ordering, not lexicographic ────────────────────────────────
{
  const base = freshRoot();
  for (const version of ["memoryV5.0.2", "memoryV5.0.9", "memoryV5.0.10"]) plant(base, version);
  const found = resolver.resolveCorpusRoot(base);
  check(
    "多个知识根时取版本号最大（5.0.10 > 5.0.9）",
    found === expected(base, "memoryV5.0.10"),
    String(found),
  );
  check(
    "与本测试自身的排序实现一致",
    found === expected(base, String(oracle.newestVersionDir(path.join(base, SUBMODULE)))),
    `${found} vs ${expected(base, String(oracle.newestVersionDir(path.join(base, SUBMODULE))))}`,
  );
}

// ── 2. names that only LOOK like knowledge roots are ignored ──────────────
{
  const base = freshRoot();
  plant(base, "memoryV5.0.2");
  for (const decoy of ["memoryV", "memoryVbeta", "memoryV5.x", "MEMORYV5.9.9", "memoryV5."]) {
    plant(base, decoy);
  }
  const found = resolver.resolveCorpusRoot(base);
  check("忽略非版本目录", found === expected(base, "memoryV5.0.2"), String(found));
}

// ── 3. no silent fallback when the newest root is broken ──────────────────
{
  const base = freshRoot();
  plant(base, "memoryV5.0.2");
  plant(base, "memoryV5.0.11", { entities: false }); // newest, but not a corpus
  const found = resolver.resolveCorpusRoot(base);
  check("最新根不完整时返回 null，不回退到旧根", found === null, String(found));
  check(
    "（前提）旧根本身是可用的",
    fs.existsSync(expected(base, "memoryV5.0.2")),
    expected(base, "memoryV5.0.2"),
  );
}

// ── 4. half-checked-out submodule reads as "not here" ─────────────────────
{
  const base = freshRoot();
  plant(base, "memoryV5.0.3", { entities: false });
  check("空检出（无 entities/index.md）返回 null", resolver.resolveCorpusRoot(base) === null);

  const base2 = freshRoot();
  plant(base2, "memoryV5.0.3", { entities: false });
  fs.writeFileSync(path.join(expected(base2, "memoryV5.0.3"), "index.md"), "# index\n", "utf8");
  check("只有 index.md 也算语料", resolver.resolveCorpusRoot(base2) === expected(base2, "memoryV5.0.3"));
}

// ── 5. the wildcard cannot escape the submodule directory ────────────────
{
  const base = freshRoot();
  plant(base, "memoryV5.0.2");
  // A newer-looking root OUTSIDE the declared submodule: isolation is the whole
  // reason the first segment stays literal.
  const decoy = path.join(base, "memoryV9.9.9", "LLMWikiExample", "LLMWikiPage", "entities");
  fs.mkdirSync(decoy, { recursive: true });
  const found = resolver.resolveCorpusRoot(base);
  check("不会吸到子模块外的同形目录", found === expected(base, "memoryV5.0.2"), String(found));
}

// ── 6. an explicit literal entry still works, and still fails loudly ─────
{
  const base = freshRoot();
  plant(base, "memoryV5.0.2");
  plant(base, "memoryV5.0.10");
  const literal = [SUBMODULE, "memoryV5.0.2", "LLMWikiExample", "LLMWikiPage"];
  check("字面 entry 精确命中所指的旧版本", resolver.resolveCorpusRoot(base, literal) === expected(base, "memoryV5.0.2"));
  const missing = [SUBMODULE, "memoryV5.7.7", "LLMWikiExample", "LLMWikiPage"];
  check("字面 entry 指向不存在的版本时返回 null", resolver.resolveCorpusRoot(base, missing) === null);
}

// ── 7. degenerate inputs ─────────────────────────────────────────────────
{
  const base = freshRoot();
  check("没有 memoryV* 目录时返回 null", resolver.resolveCorpusRoot(base) === null);
  check("空包根返回 null", resolver.resolveCorpusRoot("") === null);
  check("非字符串包根返回 null", resolver.resolveCorpusRoot(undefined) === null);
  check("不存在的包根返回 null", resolver.resolveCorpusRoot("Z:/definitely/not/here") === null);
  check("语料目录是文件而非目录时返回 null", (() => {
    const other = freshRoot();
    fs.writeFileSync(path.join(other, SUBMODULE, "memoryV5.0.2"), "not a directory", "utf8");
    return resolver.resolveCorpusRoot(other) === null;
  })());

  const barren = freshRoot();
  plant(barren, "memoryV5.0.2", { entities: false });
  let threw = null;
  try {
    resolver.requireCorpusRoot(barren);
  } catch (error) {
    threw = error;
  }
  check("requireCorpusRoot 在缺语料时抛出", threw !== null);
  check(
    "报错信息指出包根与声明布局",
    threw !== null && threw.message.includes("找不到知识库语料") && threw.message.includes(SUBMODULE),
    threw?.message?.split("\n")[0] ?? "",
  );
}

// ── 8. the real checkout: two independent oracles ────────────────────────
const realSubmodule = path.join(root, SUBMODULE);
{
  const found = resolver.resolveCorpusRoot(root);
  const newest = oracle.newestVersionDir(realSubmodule);
  check("工作区能找到语料", found !== null, String(found));
  check(
    "与本测试自身的排序实现一致（真实工作区）",
    newest !== null && found === expected(root, newest),
    `${found} vs ${expected(root, String(newest))}`,
  );

  // The shipped pin says which commit AND which layout; the resolver only scans.
  // Disagreement means one of the two was updated without the other — the exact
  // failure that shipped a stale corpus path once already.
  const prepareSource = fs.readFileSync(path.join(root, "tools", "prepare.js"), "utf8");
  const pin = /"VRChat-Agent-Creator-Library":\s*"([0-9a-f]{40})"/.exec(prepareSource)?.[1] ?? null;
  const layout = /"(memoryV[\d.]+\/LLMWikiExample\/LLMWikiPage)"/.exec(prepareSource)?.[1] ?? null;
  check("prepare.js 里有该子模块的 pin", pin !== null, String(pin));
  check("prepare.js 里有期望布局", layout !== null, String(layout));
  check(
    "解析结果 == prepare.js 期望布局",
    found !== null && layout !== null && found === path.join(realSubmodule, ...layout.split("/")),
    `${found}`,
  );

  // git's own metadata, independent of the filesystem scan.
  const git = (...args) => spawnSync("git", ["-C", realSubmodule, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) {
    skip("git 交叉验证", "语料子模块无 .git（已安装包或纯检出），只能靠文件扫描");
  } else {
    check("工作树 HEAD == prepare.js 的 pin", head.stdout.trim() === pin, `${head.stdout.trim()} vs ${pin}`);
    const tree = git("ls-tree", "--name-only", "HEAD").stdout.split("\n").filter(Boolean);
    const treeRoots = tree.filter((name) => oracle.NAME.test(name));
    check(
      "该 pin 的知识根只有一个",
      treeRoots.length === 1,
      treeRoots.join(", ") || "none",
    );
    check(
      "解析到的目录就是该 pin 里的那个",
      treeRoots.length === 1 && found === expected(root, treeRoots[0]),
      `${found} vs ${expected(root, String(treeRoots[0]))}`,
    );
    // A stray directory left on disk would win the "newest" rule while existing
    // in no commit — i.e. the plugin would answer from something unreviewed.
    const stray = git("status", "--porcelain", "--untracked-files=all").stdout
      .split("\n")
      .filter((line) => line.startsWith("??"))
      .filter((line) => /memoryV[\d.]+\//.test(line));
    check("磁盘上没有游离的知识根目录", stray.length === 0, stray.slice(0, 3).join("; ") || "none");
  }
}

// ── 9. the built data must describe the corpus that is actually there ────
{
  const manifestPath = path.join(root, "data", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    check("manifest.json 存在", false, "先跑 node tools/build-knowledge.mjs");
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const segments = resolver.corpusEntrySegments(root);
    check(
      "manifest.corpusRoot == 实际解析布局",
      segments !== null && manifest.corpusRoot === segments.join("/"),
      `${manifest.corpusRoot} vs ${String(segments?.join("/"))}`,
    );
    const index = JSON.parse(fs.readFileSync(path.join(root, "data", "index.json"), "utf8"));
    check("manifest.pageCount == index.json 条目数", manifest.pageCount === index.length, `${manifest.pageCount} vs ${index.length}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────
let failed = 0;
let skipped = 0;
for (const item of checks) {
  if (item.skipped) {
    skipped++;
    console.log(`SKIP  ${item.name}\n      ${item.detail}`);
    continue;
  }
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
}
console.log("");
console.log(
  failed === 0
    ? `全部 ${checks.length - skipped} 条通过${skipped > 0 ? `（${skipped} 条跳过）` : ""}`
    : `${failed} / ${checks.length - skipped} 条未通过`,
);
if (failed > 0) process.exitCode = 1;

for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
