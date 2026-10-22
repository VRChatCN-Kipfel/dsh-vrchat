/** Quantify what removing the duplicated section would save. */
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "data");
const t0 = fs.readFileSync(path.join(dataDir, "t0-core.txt"), "utf8");
const always = fs.readFileSync(path.join(dataDir, "always-load.txt"), "utf8");
const prefix = fs.readFileSync(path.join(dataDir, "persona-prefix.txt"), "utf8");
const suffix = fs.readFileSync(path.join(dataDir, "persona-suffix.txt"), "utf8");

const section = `${t0}\n\n---\n\n${always}`;
const provenanceLine = `\n\n> 库 v5.0.0 / 上游 414 页 / 构建 2026-10-22 · 本块 2103–3040 tok`;
const withProvenance = section.length + provenanceLine.length;

console.log("预设场景下的注入组成");
console.log(`  prefix  (order    0)  ${prefix.length} 字符`);
console.log(`  suffix  (order 10200) ${suffix.length} 字符`);
console.log(`  section (order  640)  ${withProvenance} 字符  ← 与 suffix 99.6% 重复`);
console.log(`  ─────────────────────────────`);
console.log(`  合计                  ${prefix.length + suffix.length + withProvenance} 字符`);

// CJK/ASCII banded estimate, the same method the project uses elsewhere.
const estimate = (text) => {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
    else ascii++;
  }
  return { low: Math.round(cjk / 1.6 + ascii / 4), high: Math.round(cjk / 1 + ascii / 3) };
};

const now = estimate(`${prefix}\n\n${suffix}\n\n${withProvenance ? section : ""}`);
const without = estimate(`${prefix}\n\n${suffix}`);
console.log("");
console.log(`  当前   ${now.low}–${now.high} tok`);
console.log(`  去掉 section 后  ${without.low}–${without.high} tok`);
console.log(`  节省   ${now.low - without.low}–${now.high - without.high} tok`);
