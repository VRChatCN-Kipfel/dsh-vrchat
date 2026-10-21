/**
 * Verify every tool handles its data dependencies consistently.
 *
 * The plugin has two independent data sources and they can fail separately:
 *
 *   derived artifacts (`data/*`)  ship with the package
 *   the corpus (raw markdown)     the submodule inside the package
 *
 * A tool that silently returns an empty result when either is missing teaches
 * the agent "the library has nothing on this", which is wrong. A tool that tells
 * the USER to run a build script is also wrong: that is a maintainer action.
 *
 * So each tool must declare which source it needs and react explicitly.
 *
 * Usage: node tools/tools-deps-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");

/** Split index.js into per-tool blocks by the `name: "..."` marker. */
function toolBlocks(text) {
  const markers = [...text.matchAll(/name:\s*"(vrchat_kb[a-z_]*)"\s*,\s*\n\s*description:/g)];
  const blocks = new Map();
  for (let index = 0; index < markers.length; index++) {
    const start = markers[index].index;
    // A block ends at the NEXT tool marker, or at the /vrchat command that
    // follows the last tool — otherwise the command's own text leaks into the
    // last tool's block and produces false failures.
    const nextTool = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const commandAt = text.indexOf("commands.register(", start);
    const end = commandAt !== -1 && commandAt < nextTool ? commandAt : nextTool;
    blocks.set(markers[index][1], text.slice(start, end));
  }
  return blocks;
}

const blocks = toolBlocks(source);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check("找到 6 个工具块", blocks.size === 6, [...blocks.keys()].join(", "));

/**
 * Which data source each tool needs.
 * `corpus`   reads page bodies
 * `derived`  reads a shipped artifact
 * `runtime`  reads the live machine, no KB data at all
 */
const EXPECTED = {
  vrchat_kb: "corpus",
  vrchat_kb_grep: "corpus",
  vrchat_kb_read: "corpus",
  vrchat_kb_api: "derived+corpus",
  vrchat_kb_unity: "runtime",
  vrchat_kb_scan: "runtime",
};

for (const [tool, needs] of Object.entries(EXPECTED)) {
  const block = blocks.get(tool);
  check(`${tool} 存在`, block !== undefined);
  if (block === undefined) continue;

  if (needs.includes("corpus")) {
    // Either an explicit `corpusRoot` guard or the lazy reader via `storeFor()`.
    check(
      `${tool} 检查了语料`,
      /corpusRoot|NO_CORPUS_TEXT|storeFor\(\)/.test(block),
      needs,
    );
  }
  if (needs.includes("derived")) {
    check(`${tool} 处理了派生数据缺失`, /ensureApiIndex\(\) === null|api-table\.json/.test(block), needs);
  }
  if (needs === "runtime") {
    check(
      `${tool} 不依赖语料（运行时工具）`,
      !/corpusRoot/.test(block),
      "runtime tools must not read the KB corpus",
    );
  }

  // No tool may tell the USER to run a build script: that is a maintainer step,
  // and a user cannot act on it.
  check(
    `${tool} 不向用户下达构建指令`,
    !/node tools\/build-knowledge\.mjs/.test(block),
    "runtime messages must describe the install problem, not the build step",
  );

  // Every tool that can fail must return a non-empty explanation.
  check(`${tool} 有显式失败文案`, /text:/.test(block));
}

// The scan tool reads the SESSION workspace, which is correct: it inspects user
// artifacts. It must NOT confuse that with the plugin's own corpus.
const scan = blocks.get("vrchat_kb_scan") ?? "";
check("scan 用会话工作区（正确）", /header\?\.cwd/.test(scan));
check("scan 不把会话目录当语料", !/findCorpusRoot|corpusRoot/.test(scan));

// The unity tool probes the machine and must not read KB data either.
const unity = blocks.get("vrchat_kb_unity") ?? "";
check("unity 不调用 storeFor", !/storeFor\(/.test(unity));
check("unity 用 shell 服务", /ctx\.get\("shell"\)/.test(unity));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
