/**
 * Verify that library paths cited inside the persona actually resolve.
 *
 * A persona that points at a page which does not exist teaches the agent to
 * cite a non-existent source — worse than citing nothing. The corpus is the
 * authority here, so every `concepts/...` or `entities/...` path mentioned in
 * the injected text must be a real page key.
 *
 * Usage: node tools/cited-paths.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadFromHost } = require("./lib-host-require.cjs");
const requireFromProfile = loadFromHost;
const YAML = requireFromProfile("yaml");
const { workingPatch, locateRows } = require("./lib-patch-rows.cjs");

const root = path.join(__dirname, "..");
// The index carries every page path; bodies live in the workspace checkout now,
// so path existence is answered from the index rather than from a body map.
const index = JSON.parse(fs.readFileSync(path.join(root, "data", "index.json"), "utf8"));
const known = new Set(index.map((entry) => entry.path));
const patch = workingPatch();

// Locate the preset by identity: `insert[0]` is the always-on row, not the preset.
const persona = locateRows(patch).persona;
if (persona === undefined) {
  console.error("找不到 persona 行——补丁结构变了，本检查无法核对引用");
  process.exit(1);
}
const texts = {
  prefix: persona?.config?.prefix ?? "",
  suffix: persona?.config?.suffix ?? "",
};

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

let total = 0;
for (const [label, text] of Object.entries(texts)) {
  const refs = [...new Set([...text.matchAll(/(?:concepts|entities)\/[\w\-./]+\.md/g)].map((m) => m[0]))];
  total += refs.length;
  const missing = refs.filter((ref) => !known.has(ref));
  check(`${label} 引用的库内路径全部存在`, missing.length === 0, missing.join(", ") || `${refs.length} 条`);
  for (const ref of refs) console.log(`    ${known.has(ref) ? "OK  " : "MISS"}  ${ref}`);
}

check("至少引用了一处库内路径", total > 0, `${total} 处`);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
