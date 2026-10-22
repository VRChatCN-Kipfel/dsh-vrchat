/** Report the installed persona cost, read from the installed generation. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");
const { installedPatch, locateRows } = require("./lib-patch-rows.cjs");

const generationsLib = require("./lib-generation.cjs");

const target = generationsLib.newestGeneration("dsh-vrchat-kb+");
const patch = installedPatch(path.join(generationsLib.liveRoot(), target, "node_modules", "dsh-vrchat-kb"));

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const price = (text) => {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else ascii++;
  }
  return { low: Math.round(cjk / 1.6 + ascii / 4), high: Math.round(cjk / 1 + ascii / 3) };
};

// Locate the preset by identity: `insert[0]` is the always-on row, not the preset.
const persona = locateRows(patch).persona;
if (persona === undefined) {
  console.error("找不到 persona 行——补丁结构变了，无法报价");
  process.exit(1);
}
console.log(`代: ${target}`);
let low = 0;
let high = 0;
for (const [label, text] of [
  ["prefix (order 0)", persona.config.prefix],
  ["suffix (order 10200)", persona.config.suffix],
]) {
  const p = price(text);
  low += p.low;
  high += p.high;
  console.log(`  ${label.padEnd(22)} ${String(text.length).padStart(5)} 字符  ~${p.low}–${p.high} tok`);
}
console.log(`  ${"预设合计（仅 persona）".padEnd(20)} ${" ".repeat(5)}        ~${low}–${high} tok`);
console.log("");
console.log("注：预设内还有 vrchat-kb 插件注册的 vrchat-kb section（域块），此处不计。");
