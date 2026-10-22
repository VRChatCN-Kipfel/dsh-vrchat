/**
 * Measure line-ending inconsistency in the corpus and trace what it affects.
 *
 * The build normalizes CRLF→LF before computing `size`, so `index.json` records
 * a normalized length. Runtime code reads pages straight from disk, so a CRLF
 * page reaches the tools with `\r` still in it. Whether that matters depends on
 * where the `\r` lands, so measure instead of assuming.
 *
 * Usage: node tools/lineending-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const corpus = path.join(root, "VRChat-Agent-Creator-Library", "memoryV5.0.0", "LLMWikiExample", "LLMWikiPage");

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else if (item.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = walk(corpus);
const crlf = [];
const lf = [];
for (const file of files) {
  const buf = fs.readFileSync(file);
  const text = buf.toString("utf8");
  const hasCrlf = text.includes("\r\n");
  const rel = path.relative(corpus, file).replace(/\\/g, "/");
  if (hasCrlf) crlf.push({ rel, crlfCount: (text.match(/\r\n/g) ?? []).length, lfOnly: (text.match(/(?<!\r)\n/g) ?? []).length });
  else lf.push(rel);
}

console.log(`语料 ${files.length} 页`);
console.log(`  CRLF 含:\t${crlf.length}`);
console.log(`  纯 LF:\t${lf.length}`);
for (const item of crlf) console.log(`    ${item.rel}  CRLF ${item.crlfCount} 处, 单独 LF ${item.lfOnly} 处`);

// ── does the mixed ending reach the tools? ───────────────────────────────
//
// The corpus is checked out with CRLF on every page. That is upstream's state
// and not ours to change, so the question is not "is the corpus clean" but "does
// the CRLF reach the model". It did: `bodyOf` used to read pages verbatim, so
// `readPage` (which splits on `\n` and never trims) emitted `\r` on every line,
// while `grepPages` looked clean because `clip()` trims. That asymmetry is what
// hid the bug.
//
// So the check is anchored on the STORE, which is the single entry point for
// corpus text, rather than on the corpus files.
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const sample = crlf[0]?.rel ?? "entities/api/not-exposed.md";
const rawOnDisk = fs.readFileSync(path.join(corpus, ...sample.split("/")), "utf8");
check(`语料本身是 CRLF（上游状态，${sample}）`, rawOnDisk.includes("\r\n"), "不改语料，改读取层");

async function main() {
// The store must hand out normalized text.
const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);
const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);
const corpusRoot = search.findCorpusRoot(root);
const store = search.createStore(path.join(root, "data"), corpusRoot);
const served = store.bodyOf(sample);
check("store 交出的正文不含 \\r", served !== null && !served.includes("\r"), served === null ? "null" : `${served.length} 字符`);
check("store 交出的行尾是 \\n", served !== null && served.includes("\n") && !served.includes("\r\n"));

// And the tools built on it must be clean, both of them, not just grep.
const paths = store.index.map((entry) => entry.path);
const readResult = docs.readPage(store.bodyOf, paths, sample, 1, 40);
check("vrchat_kb_read 输出不含 \\r", readResult.ok && !readResult.text.includes("\r"), (readResult.text.match(/\r/g) ?? []).length + " 处");

const grepResult = docs.grepPages(paths, store.bodyOf, "Udon", { maxMatches: 5 });
check("vrchat_kb_grep 输出不含 \\r", grepResult.ok && !grepResult.text.includes("\r"));

// The same must hold for a page that is NOT the sample, or the fix is local.
const other = store.index.map((e) => e.path).find((p) => p !== sample);
const otherBody = store.bodyOf(other);
check(`另一页（${other}）同样不含 \\r`, otherBody !== null && !otherBody.includes("\r"));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;

}

main().catch((error) => { console.error(error); process.exit(1); });
