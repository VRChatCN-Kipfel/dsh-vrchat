/**
 * Cross-check the DERIVED index against the corpus it claims to describe.
 *
 * `index.json` records each page's `path`, `title`, `confidence` and `size`.
 * Nothing has ever verified those against the files actually on disk, so a stale
 * index would silently disagree with the pages a query then reads. This is a
 * third independent path: git holds the corpus, the build wrote the index, and
 * reality is `readFileSync` right now — all three must agree.
 *
 * Usage: node tools/index-corpus-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const corpus = path.join(root, "VRChat-Agent-Creator-Library", "memoryV5.0.0", "LLMWikiExample", "LLMWikiPage");
const index = JSON.parse(fs.readFileSync(path.join(root, "data", "index.json"), "utf8"));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

/**
 * Frontmatter scalars, parsed the same way the build does.
 * Duplicated deliberately: if the two implementations drift, this check is
 * supposed to notice, not to agree by sharing the bug.
 */
function parseScalars(raw) {
  const meta = {};
  if (!raw.startsWith("---\n")) return meta;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return meta;
  let list = null;
  for (const line of raw.slice(4, end).split("\n")) {
    if (/^\s*-\s+/.test(line)) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === "") {
      list = kv[1];
      continue;
    }
    list = null;
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

// ── 1. every indexed path must exist on disk ─────────────────────────────
const missing = [];
for (const entry of index) {
  const file = path.join(corpus, ...entry.path.split("/"));
  if (!fs.existsSync(file)) missing.push(entry.path);
}
check("索引里的每条路径都在磁盘上", missing.length === 0, missing.slice(0, 5).join(", ") || `${index.length} 页`);

// ── 2. every markdown on disk must be indexed (no silent orphans) ────────
const walk = (dir, out = []) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else if (item.name.endsWith(".md")) out.push(path.relative(corpus, full).replace(/\\/g, "/"));
  }
  return out;
};
const onDisk = walk(corpus);
const indexed = new Set(index.map((entry) => entry.path));
const orphans = onDisk.filter((rel) => !indexed.has(rel));
check("磁盘上每页都被索引收录", orphans.length === 0, orphans.slice(0, 5).join(", ") || `${onDisk.length} 页`);

// ── 3. `size` must equal the current file length ────────────────────────
//
// This is the one that catches a stale index: the build recorded a length, and
// if the page was edited afterwards the number no longer matches.
const sizeDrift = [];
for (const entry of index) {
  const raw = fs.readFileSync(path.join(corpus, ...entry.path.split("/")), "utf8").replace(/\r\n/g, "\n");
  if (raw.length !== entry.size) sizeDrift.push(`${entry.path}: index=${entry.size} disk=${raw.length}`);
}
check("索引记录的 size 与磁盘一致", sizeDrift.length === 0, sizeDrift.slice(0, 3).join("; ") || `${index.length} 页`);

// ── 4. title must match the page's own frontmatter ──────────────────────
const titleDrift = [];
for (const entry of index) {
  const raw = fs.readFileSync(path.join(corpus, ...entry.path.split("/")), "utf8").replace(/\r\n/g, "\n");
  const meta = parseScalars(raw);
  const expected = typeof meta.title === "string" ? meta.title : entry.path.replace(/\.md$/, "");
  if (entry.title !== expected) titleDrift.push(`${entry.path}: index="${entry.title}" page="${expected}"`);
}
check("索引 title 与页面 frontmatter 一致", titleDrift.length === 0, titleDrift.slice(0, 3).join("; ") || `${index.length} 页`);

// ── 5. confidence must match too (the UI shows it) ──────────────────────
const confDrift = [];
for (const entry of index) {
  const raw = fs.readFileSync(path.join(corpus, ...entry.path.split("/")), "utf8").replace(/\r\n/g, "\n");
  const meta = parseScalars(raw);
  const expected = typeof meta.confidence === "string" ? meta.confidence.toLowerCase() : null;
  const actual = entry.confidence ?? null;
  if (actual !== expected) confDrift.push(`${entry.path}: index=${actual} page=${expected}`);
}
check("索引 confidence 与页面一致", confDrift.length === 0, confDrift.slice(0, 3).join("; ") || `${index.length} 页`);

// ── 6. no duplicate paths (a duplicate would shadow in the page cache) ───
const seen = new Set();
const dupes = [];
for (const entry of index) {
  if (seen.has(entry.path)) dupes.push(entry.path);
  seen.add(entry.path);
}
check("索引无重复路径", dupes.length === 0, dupes.join(", ") || "none");

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
