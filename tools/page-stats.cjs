/** Page-size distribution: decides whether the read tool needs pagination. */
const fs = require("node:fs");
const path = require("node:path");
const { requireCorpusRoot } = require("../lib/corpus-root.cjs");

// Reads the corpus in place. This used to read `data/pages.json` — a bundle that
// held every page body — which the current packaging removed (bodies live in the
// submodule and are opened on demand), so the tool simply crashed with ENOENT.
const corpus = requireCorpusRoot(path.join(__dirname, ".."));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const rows = walk(corpus).map((file) => {
  const body = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return {
    file: path.relative(corpus, file).split(path.sep).join("/"),
    chars: body.length,
    lines: body.split("\n").length,
  };
});
rows.sort((a, b) => b.chars - a.chars);

console.log(`总页数: ${rows.length}`);
console.log("最大 5 页:");
for (const row of rows.slice(0, 5)) {
  console.log(`  ${String(row.chars).padStart(7)} chars ${String(row.lines).padStart(5)} lines  ${row.file}`);
}
const over200 = rows.filter((row) => row.lines > 200).length;
const mid = rows.filter((row) => row.lines > 80 && row.lines <= 200).length;
const under80 = rows.filter((row) => row.lines <= 80).length;
console.log(`>200 行: ${over200} 页 | 80-200 行: ${mid} 页 | <=80 行: ${under80} 页`);
console.log(`中位行数: ${rows[Math.floor(rows.length / 2)].lines}`);
const totalChars = rows.reduce((acc, row) => acc + row.chars, 0);
console.log(`平均 ${Math.round(totalChars / rows.length)} chars/页`);
