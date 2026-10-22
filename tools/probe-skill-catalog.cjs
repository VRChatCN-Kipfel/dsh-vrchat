/**
 * Measure how each skill's description renders in the catalog.
 *
 * The catalog gives the model ONE line per skill: `- \`name\`: description`, with
 * the description whitespace-collapsed and truncated at 500 characters. So the
 * description is not "documentation the model can skim" — it is the entire routing
 * signal, and anything past 500 characters is dead weight.
 *
 * Usage: node tools/probe-skill-catalog.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const SKILLS_DIR = path.join(__dirname, "..", "vendor", "vrchat-world-codex-skills");
const MAX = 500;

/** Read name/description from a SKILL.md, normalizing CRLF. */
function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const meta = {};
  for (const line of text.slice(4, end).split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2].length > 0) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

const candidates = [
  "SKILL.md",
  "build-vrchat-world/SKILL.md",
  "design-modular-vrchat-world/SKILL.md",
  "coordinate-transform-audit/SKILL.md",
];

let total = 0;
console.log(`catalog 上限 ${MAX} 字符 / skill\n`);
console.log("=".repeat(78));

for (const rel of candidates) {
  const file = path.join(SKILLS_DIR, ...rel.split("/"));
  if (!fs.existsSync(file)) continue;
  const meta = frontmatter(file);
  if (meta === null) continue;

  const collapsed = (meta.description ?? "").replaceAll(/\s+/g, " ").trim();
  const rendered = collapsed.length <= MAX ? collapsed : `${collapsed.slice(0, MAX - 3)}...`;
  const over = collapsed.length > MAX;
  total += rendered.length;

  console.log(`\nname: ${meta.name}`);
  console.log(`description 原始 ${collapsed.length} 字符${over ? `  ⚠️ 超出上限 ${collapsed.length - MAX}` : ""}`);
  console.log(`实际渲染 ${rendered.length} 字符`);
  console.log(`渲染行：- \`${meta.name}\`: ${rendered.slice(0, 160)}${rendered.length > 160 ? "…" : ""}`);

  if (over) {
    console.log(`\n⚠️ 被截断的部分（模型看不到）：`);
    console.log(`   …${collapsed.slice(MAX - 3, MAX + 120)}…`);
  }
}

console.log("\n" + "=".repeat(78));
console.log(`四个技能在 catalog 里的 description 合计 ${total} 字符`);
console.log(`（这是每个会话开头都要付的常驻成本）`);
