/**
 * Measure the three top-level entry files with CJK-aware token estimation,
 * and report heading structure so the routing/navigation ratio is visible.
 *
 * Usage: node tools/measure-entry-files.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(
  __dirname,
  "..",
  "..",
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
);

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function measure(text) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else ascii++;
  }
  return {
    chars: text.length,
    lines: text.split("\n").length,
    cjk,
    ascii,
    low: Math.round(cjk / 1.6 + ascii / 4.0),
    high: Math.round(cjk / 1.0 + ascii / 3.0),
  };
}

const files = ["_always-load.md", "FACT.md", "index.md"];
let total = { low: 0, high: 0, chars: 0 };

console.log("file".padEnd(18) + "chars".padStart(8) + "lines".padStart(7) + "CJK".padStart(7) + "ASCII".padStart(7) + "tok-low".padStart(9) + "tok-high".padStart(9) + "  H2  H3  tables");
console.log("-".repeat(96));

for (const name of files) {
  const text = fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
  const m = measure(text);
  const h2 = (text.match(/^## /gm) || []).length;
  const h3 = (text.match(/^### /gm) || []).length;
  const tables = (text.match(/^\|/gm) || []).length;
  console.log(
    name.padEnd(18) +
      String(m.chars).padStart(8) +
      String(m.lines).padStart(7) +
      String(m.cjk).padStart(7) +
      String(m.ascii).padStart(7) +
      String(m.low).padStart(9) +
      String(m.high).padStart(9) +
      String(h2).padStart(5) +
      String(h3).padStart(4) +
      String(tables).padStart(8),
  );
  total.low += m.low;
  total.high += m.high;
  total.chars += m.chars;
}

console.log("-".repeat(96));
console.log(`三文件合计${" ".repeat(12)}${String(total.chars).padStart(8)}${" ".repeat(38)}${String(total.low).padStart(9)}${String(total.high).padStart(9)}`);

// Second-level headings of each file: shows what kind of content occupies the space.
for (const name of files) {
  const text = fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
  console.log(`\n=== ${name} 的二级标题 ===`);
  const lines = text.split("\n");
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      const start = i;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^## /.test(lines[j])) {
          end = j;
          break;
        }
      }
      const seg = lines.slice(start, end).join("\n");
      const m = measure(seg);
      console.log(`  ${lines[i].replace(/^## /, "").slice(0, 40).padEnd(42)} ${String(m.chars).padStart(6)} chars  ~${m.low}-${m.high} tok`);
    }
  }
}
