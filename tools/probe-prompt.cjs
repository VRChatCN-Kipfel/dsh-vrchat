/**
 * Read the Host's own system-prompt renderer to answer a design question.
 *
 * Kept as a probe because the answer is a one-time fact that later gets encoded in
 * index.js: our section APPENDS (it does not replace the prompt), and
 * `PromptSection.complete: true` is the only way to replace. Re-reading the source
 * is cheaper than trusting a comment.
 *
 * Usage: node tools/probe-prompt.cjs
 */
const fs = require("node:fs");

const { findHostModules } = require("./lib-host-modules.cjs");

const file = findHostModules("@deepseek-ai/dsh-system-prompt/lib/index.js");
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
