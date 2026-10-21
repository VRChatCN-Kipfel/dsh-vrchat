/** Determine whether our section replaces or appends to the system prompt. */
const fs = require("node:fs");

const file =
  "D:/Program Files/DSH Desktop/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js";
const text = fs.readFileSync(file, "utf8");

// The renderer that joins sections.
const idx = text.indexOf("assembly.sections.map");
console.log("=== sections 渲染 ===");
console.log(text.slice(Math.max(0, idx - 700), idx + 300));

// PERSONA_PREFIX_SECTION shadowing doc.
const p = text.indexOf("const PERSONA_PREFIX_SECTION");
console.log("\n=== persona 前缀的 shadow 说明 ===");
console.log(text.slice(Math.max(0, p - 600), p + 200));

// Whether a section can suppress others.
const s = text.indexOf("suppressRuntimeContext");
console.log("\n=== suppressRuntimeContext ===");
console.log(text.slice(Math.max(0, s - 400), s + 400));
