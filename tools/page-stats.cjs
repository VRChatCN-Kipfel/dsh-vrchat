/** Page-size distribution: decides whether the read tool needs pagination. */
const fs = require("node:fs");
const path = require("node:path");

const pages = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "pages.json"), "utf8"));
const rows = Object.entries(pages).map(([file, body]) => ({
  file,
  chars: body.length,
  lines: body.split("\n").length,
}));
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
