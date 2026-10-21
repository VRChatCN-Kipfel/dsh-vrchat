/**
 * CJK-aware token estimate for the curated blocks, plus the compression ratio
 * against the upstream `_always-load.md`.
 *
 * This is still an ESTIMATE. The authoritative number comes from
 * `ctx.tokenMeter.measure()` on a live session once the plugin is installed.
 */
const fs = require("node:fs");
const path = require("node:path");

const bundle = path.join(__dirname, "..");
const upstream = path.join(
  __dirname,
  "..",
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
  "_always-load.md",
);

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** Split into CJK and ASCII character counts. */
function count(text) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else ascii++;
  }
  return { cjk, ascii };
}

/** Low bound: generous characters-per-token. High bound: conservative. */
const bounds = ({ cjk, ascii }) => ({
  low: Math.round(cjk / 1.6 + ascii / 4.0),
  high: Math.round(cjk / 1.0 + ascii / 3.0),
});

const blocks = {
  "t0-core": "t0-core.txt",
  "t1-world": "t1-world.txt",
  "t1-avatar": "t1-avatar.txt",
  "t1-shader": "t1-shader.txt",
  "domain-map": "domain-map.txt",
  "always-load": "always-load.txt",
};

const rows = [];
let defaultLow = 0;
let defaultHigh = 0;
let presetLow = 0;
let presetHigh = 0;

for (const [key, file] of Object.entries(blocks)) {
  const text = fs.readFileSync(path.join(bundle, "data", file), "utf8");
  const c = count(text);
  const b = bounds(c);
  rows.push({ key, chars: text.length, ...c, ...b });
  if (key === "t0-core") {
    defaultLow += b.low;
    defaultHigh += b.high;
  }
  if (key.startsWith("t1-")) {
    defaultLow += b.low;
    defaultHigh += b.high;
  }
  if (key !== "always-load") {
    presetLow += b.low;
    presetHigh += b.high;
  }
}

const rawText = fs.readFileSync(upstream, "utf8").replace(/\r\n/g, "\n");
const rawCount = count(rawText);
const rawBounds = bounds(rawCount);

console.log("block".padEnd(13) + "bytes".padStart(7) + "CJK".padStart(7) + "ASCII".padStart(7) + "tok-low".padStart(9) + "tok-high".padStart(9));
console.log("-".repeat(52));
for (const r of rows) {
  console.log(
    r.key.padEnd(13) +
      String(Buffer.byteLength(fs.readFileSync(path.join(bundle, "data", blocks[r.key]), "utf8"), "utf8")).padStart(7) +
      String(r.cjk).padStart(7) +
      String(r.ascii).padStart(7) +
      String(r.low).padStart(9) +
      String(r.high).padStart(9),
  );
}
console.log("-".repeat(52));
console.log("upstream _always-load.md".padEnd(13) + String(Buffer.byteLength(rawText, "utf8")).padStart(7) + String(rawCount.cjk).padStart(7) + String(rawCount.ascii).padStart(7) + String(rawBounds.low).padStart(9) + String(rawBounds.high).padStart(9));

console.log("");
console.log(`upstream  _always-load.md      ~${rawBounds.low}–${rawBounds.high} tok`);
console.log(`default   T0 only              ~${rows[0].low}–${rows[0].high} tok`);
console.log(`default   T0 + all T1 (worst)  ~${defaultLow}–${defaultHigh} tok`);
console.log(`preset    domain+all T1 (no T0, T0 merged in) ~${presetLow}–${presetHigh} tok`);
console.log("");
console.log(`compression (upstream → preset payload): ${(rawBounds.low / presetHigh).toFixed(2)}x ~ ${(rawBounds.high / presetLow).toFixed(2)}x`);
console.log(`             ${rawText.length} chars → ${rows.find((r) => r.key === "always-load").chars + rows[0].chars} chars (preset incl. T0 tail)`);
