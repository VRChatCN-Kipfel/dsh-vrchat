/**
 * Verify the read tool DECLARES its frontmatter and line-number semantics.
 *
 * The behaviour (skip YAML metadata by default, keep the file's own line numbers)
 * is only usable if the model knows it. A silent skip looks like a bug; an
 * unexplained default makes `offset` arithmetic guesswork. So the description and
 * the parameter docs must state:
 *
 *   1. the default skips frontmatter
 *   2. line numbers are NOT renumbered when it does
 *   3. grep line numbers chain into offset
 *   4. offset=1 reads the metadata
 *
 * Usage: node tools/read-doc-contract-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");

// Isolate the vrchat_kb_read block.
const start = source.indexOf('name: "vrchat_kb_read"');
const end = source.indexOf('name: "vrchat_kb_api"');
const block = start === -1 || end === -1 ? "" : source.slice(start, end);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check("能定位 read 工具定义", block.length > 500, `${block.length} 字符`);

// ── the description must declare the skip ────────────────────────────────
check("描述声明默认跳过 YAML 元数据", /默认跳过页面开头的 YAML 元数据/.test(block));
check("描述说明跳到正文首行", /从正文首行开始/.test(block));
check("描述说明会注明跳过的行数", /跳过了第 1–N 行|跳过.*行/.test(block));
check("描述说明 offset=1 可读元数据", /offset=1/.test(block));

// ── line numbers must be declared non-drifting ──────────────────────────
check("描述声明行号不漂移", /行号不会因为跳过而漂移/.test(block));
check("描述声明行号是文件真实行号", /真实行号/.test(block));
check("描述声明 grep 行号可直连 offset", /Line 240.*offset=240|offset=240/.test(block));

// ── path expectations must be stated, not implied ───────────────────────
check("描述声明路径是库内相对", /路径是库内相对的/.test(block));
check("描述声明不接受绝对路径", /不接受绝对路径/.test(block));
check("描述声明语料随包、与工作区无关", /语料随插件包分发/.test(block));

// ── the parameter doc must not contradict the description ───────────────
const offsetDoc = /offset: \{[\s\S]*?description:\s*([\s\S]*?)\n\s*\},/.exec(block);
check("能读到 offset 参数的说明", offsetDoc !== null);
if (offsetDoc !== null) {
  const text = offsetDoc[1];
  check(
    "offset 说明不再写「默认 1」",
    !/默认\s*1(?!\d)/.test(text),
    "默认已改为正文首行，写成 1 会误导",
  );
  check("offset 说明写了不传时的行为", /不传则从正文首行开始/.test(text));
  check("offset 说明写了传 1 的行为", /传 1 则从文件第 1 行/.test(text));
  check("offset 说明提到引用真实行号", /真实行号/.test(text));
}

// ── and the implementation must honour it (no `: 1` default in the tool) ──
const impl = /const offset = Number\.isInteger\(args\?\.offset\) \? args\.offset : (\w+);/.exec(block);
check("能读到 offset 的实现", impl !== null);
check(
  "实现不在工具层补默认 1",
  impl !== null && impl[1] === "undefined",
  impl === null ? "" : `实际: ${impl[1]}`,
);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
