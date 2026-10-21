/**
 * Measure the real cost of loading data/pages.json at plugin activation.
 *
 * `createStore` runs inside `apply()`, which happens during Harness startup, so
 * a slow parse delays boot and a large artifact inflates every generation copy.
 */
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "data");

function bytes(name) {
  try {
    return fs.statSync(path.join(dataDir, name)).size;
  } catch {
    return null;
  }
}

const sizes = {};
for (const name of ["pages.json", "index.json", "api-table.json", "keyword-routes.json", "manifest.json"]) {
  sizes[name] = bytes(name);
}

console.log("data/ 体积:");
let total = 0;
for (const [name, size] of Object.entries(sizes)) {
  if (size === null) continue;
  total += size;
  console.log(`  ${name.padEnd(22)} ${(size / 1024).toFixed(1)} KB`);
}
console.log(`  ${"合计".padEnd(20)} ${(total / 1024 / 1024).toFixed(2)} MB`);

// Time the parse exactly as apply() does it.
const started = process.hrtime.bigint();
const raw = fs.readFileSync(path.join(dataDir, "pages.json"), "utf8");
const readMs = Number(process.hrtime.bigint() - started) / 1e6;

const parseStart = process.hrtime.bigint();
const pages = JSON.parse(raw);
const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6;

const pageCount = Object.keys(pages).length;
let bodyChars = 0;
let bodyLines = 0;
for (const body of Object.values(pages)) {
  bodyChars += body.length;
  bodyLines += body.split("\n").length;
}

console.log("");
console.log("加载成本（apply() 里同步执行）:");
console.log(`  读取   ${readMs.toFixed(1)} ms   ${(raw.length / 1024 / 1024).toFixed(2)} MB 字符`);
console.log(`  解析   ${parseMs.toFixed(1)} ms`);
console.log(`  合计   ${(readMs + parseMs).toFixed(1)} ms`);
console.log(`  常驻   ${pageCount} 页 / ${bodyChars.toLocaleString()} 字符 / ${bodyLines.toLocaleString()} 行`);

// What the vocabulary pass costs on top, since it touches every page.
const vocabStart = process.hrtime.bigint();
let tokens = 0;
for (const body of Object.values(pages)) {
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) tokens += line.length;
  }
}
const vocabMs = Number(process.hrtime.bigint() - vocabStart) / 1e6;
console.log(`  词表扫描 ${vocabMs.toFixed(1)} ms（仅标题行）`);

console.log("");
console.log("每代安装都会在磁盘上复制一份:");
console.log(`  packages/.generations/live/<gen>/node_modules/dsh-vrchat-kb/data/`);
const generations = path.join(
  process.env.DSH_HOME ?? "",
  "profiles",
  ".generations",
  "live",
);
if (fs.existsSync(generations)) {
  const gens = fs.readdirSync(generations).filter((n) => n.startsWith("dsh-vrchat-kb+"));
  let installed = 0;
  for (const gen of gens) {
    const f = path.join(generations, gen, "node_modules", "dsh-vrchat-kb", "data", "pages.json");
    if (fs.existsSync(f)) installed += fs.statSync(f).size;
  }
  console.log(`  已装 ${gens.length} 代 → pages.json 共占 ${(installed / 1024 / 1024).toFixed(1)} MB`);
}
