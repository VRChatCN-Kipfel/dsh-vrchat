/**
 * Measure what it costs to derive the index from the RAW markdown at runtime,
 * instead of compiling it into data/index.json at build time.
 *
 * If this is cheap enough, the build step for derived data disappears entirely:
 * the raw files ARE the source, there is nothing to keep in sync, and upstream
 * updates are picked up without a rebuild.
 */
const fs = require("node:fs");
const path = require("node:path");

const CORPUS = path.join(
  __dirname,
  "..",
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Minimal frontmatter parse: only the scalar keys ranking needs. */
function parseFrontmatter(raw) {
  const meta = {};
  if (!raw.startsWith("---\n")) return meta;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return meta;
  let list = null;
  for (const line of raw.slice(4, end).split("\n")) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && list !== null) {
      meta[list].push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === "") {
      list = kv[1];
      meta[kv[1]] = [];
    } else {
      list = null;
      meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return meta;
}

// Pass 1: walk + read + parse frontmatter only (what index.json carries).
const t1 = process.hrtime.bigint();
const files = walk(CORPUS);
const entries = [];
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const meta = parseFrontmatter(raw);
  entries.push({
    path: path.relative(CORPUS, file).replace(/\\/g, "/"),
    title: meta.title,
    confidence: meta.confidence,
    tags: meta.tags ?? [],
  });
}
const indexMs = Number(process.hrtime.bigint() - t1) / 1e6;

console.log(`裸文件 → 索引`);
console.log(`  文件数 ${files.length}`);
console.log(`  耗时   ${indexMs.toFixed(1)} ms`);
console.log(`  条目   标题齐全 ${entries.filter((e) => typeof e.title === "string").length}`);
console.log(`        置信度齐全 ${entries.filter((e) => typeof e.confidence === "string").length}`);

// Pass 2: what a query actually needs — bodies of the few pages it hits.
const t2 = process.hrtime.bigint();
const sample = entries.slice(0, 4);
let chars = 0;
for (const entry of sample) chars += fs.readFileSync(path.join(CORPUS, ...entry.path.split("/")), "utf8").length;
const readMs = Number(process.hrtime.bigint() - t2) / 1e6;
console.log(`\n命中 4 页读正文`);
console.log(`  耗时 ${readMs.toFixed(2)} ms / ${chars} 字符`);

// Pass 3: cost of the shipped artifacts for comparison.
const dataDir = path.join(__dirname, "..", "data");
for (const name of ["index.json", "api-table.json", "keyword-routes.json"]) {
  const p = path.join(dataDir, name);
  if (!fs.existsSync(p)) continue;
  const t = process.hrtime.bigint();
  const text = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(text);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`\n${name}`);
  console.log(`  ${(text.length / 1024).toFixed(1)} KB, 解析 ${ms.toFixed(2)} ms, ${Array.isArray(parsed) ? parsed.length + " 条" : Object.keys(parsed).length + " 键"}`);
}

// Pass 4: api-table derivation cost from the single source page.
const exposed = path.join(CORPUS, "entities", "api", "exposed-types.md");
const t4 = process.hrtime.bigint();
const exposedRaw = fs.readFileSync(exposed, "utf8");
const types = (exposedRaw.match(/^### /gm) ?? []).length;
const members = (exposedRaw.match(/^- `/gm) ?? []).length;
const apiMs = Number(process.hrtime.bigint() - t4) / 1e6;
console.log(`\nexposed-types.md`);
console.log(`  ${(exposedRaw.length / 1024).toFixed(1)} KB, 读取+粗解析 ${apiMs.toFixed(2)} ms, ${types} 类型 / ${members} 成员行`);
