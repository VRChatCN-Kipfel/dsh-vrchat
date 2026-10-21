/** Summarize what this plugin actually delivers, from the source itself. */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");

const tools = [...index.matchAll(/name:\s*"(vrchat_kb[a-z_]*)"/g)].map((m) => m[1]);
console.log(`工具 (${tools.length}):`);
for (const tool of tools) console.log(`  ${tool}`);

const commands = [...index.matchAll(/commands\.register\(\{[\s\S]*?name:\s*"([^"]+)"/g)].map((m) => m[1]);
console.log(`命令 (${commands.length}): ${commands.join(", ")}`);

const sections = [...index.matchAll(/systemPrompt\.section\(\{[\s\S]*?name:\s*"([^"]+)"/g)].map((m) => m[1]);
console.log(`注入 section: ${sections.join(", ") || "(none)"}`);

const projections = [...index.matchAll(/key:\s*"([^"]+)"[\s\S]{0,80}stateSchema/g)].map((m) => m[1]);
console.log(`投影 unit: ${projections.join(", ") || "(none)"}`);

// Static guards: what each tool suite actually protects against.
const toolsDir = path.join(root, "tools");
const suites = fs
  .readdirSync(toolsDir)
  .filter((f) => /(selftest|check|verify)/.test(f) && f !== "summarize.cjs")
  .sort();
console.log(`\n护栏脚本 (${suites.length}):`);
for (const name of suites) {
  const text = fs.readFileSync(path.join(toolsDir, name), "utf8");
  const count = (text.match(/^\s*check\(/gm) ?? []).length;
  const title = /^\/\*\*\s*\n\s*\*\s*(.+)/.exec(text);
  console.log(`  ${name.padEnd(30)} ~${count} 条  ${title === null ? "" : title[1].slice(0, 50)}`);
}
