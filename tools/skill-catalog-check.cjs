/**
 * Verify every skill's description survives the catalogue's rendering.
 *
 * The catalogue shows the model one line per skill — `- \`name\`: description` —
 * with whitespace collapsed and the text truncated at 500 characters. That line is
 * the ENTIRE routing signal: the body is only read after the model decides to load
 * the skill. Two failure modes follow, and both are silent:
 *
 *   · exceeding the limit  → the tail is cut, so whatever was placed last never
 *                            reaches the model. Anything stated after character 500
 *                            may as well not be written.
 *   · too short            → nothing is cut, but the line stops naming its
 *                            trigger conditions and the model has to guess.
 *
 * So this checks the rendered length, that the description names when to use the
 * skill, and that it states at least one exclusion where the skill has
 * neighbouring skills to be confused with.
 *
 * Usage: node tools/skill-catalog-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const SKILLS_DIR = path.join(__dirname, "..", "vendor", "vrchat-world-codex-skills");

/** The catalogue limit, mirrored from dsh-tool-skill's default config. */
const CATALOG_LIMIT = 500;

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

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const candidates = [
  "SKILL.md",
  "build-vrchat-world/SKILL.md",
  "design-modular-vrchat-world/SKILL.md",
  "coordinate-transform-audit/SKILL.md",
];

let totalRendered = 0;
const names = [];

for (const rel of candidates) {
  const file = path.join(SKILLS_DIR, ...rel.split("/"));
  if (!fs.existsSync(file)) continue;
  const meta = frontmatter(file);
  if (meta === null) continue;

  names.push(meta.name);
  const collapsed = (meta.description ?? "").replaceAll(/\s+/g, " ").trim();
  const rendered = collapsed.length <= CATALOG_LIMIT ? collapsed : `${collapsed.slice(0, CATALOG_LIMIT - 3)}...`;
  totalRendered += rendered.length;

  // 1. It must fit, or text is silently discarded.
  check(
    `${meta.name} 描述不超过 catalog 上限`,
    collapsed.length <= CATALOG_LIMIT,
    `${collapsed.length} / ${CATALOG_LIMIT}${collapsed.length > CATALOG_LIMIT ? " — 超出部分模型看不到" : ""}`,
  );

  // 2. It must be long enough to say something routable.
  check(`${meta.name} 描述足够长`, collapsed.length >= 80, `${collapsed.length} 字符`);

  // 3. It must name when to use it, not just what it does.
  check(
    `${meta.name} 描述含触发条件`,
    /use when|适用于|当.*时|when .* needed|从这里开始/i.test(collapsed),
    collapsed.slice(0, 60),
  );

  // 4. Neighbouring skills must each state an exclusion, or they get picked wrongly.
  check(
    `${meta.name} 描述含排除条件`,
    /not (need|for|use)|do not use|不适用|不必|skip/i.test(collapsed),
    collapsed.slice(-60),
  );
}

check("四个技能全部找到", names.length === 4, names.join(", "));

// The entry skill must be distinguishable from the three it routes to.
const entry = frontmatter(path.join(SKILLS_DIR, "SKILL.md"));
check("入口技能名为 vrchat-world", entry?.name === "vrchat-world", String(entry?.name));
check(
  "入口技能名不含工具/仓库后缀",
  entry?.name !== undefined && !/(codex|skills|repo)$/i.test(entry.name),
  String(entry?.name),
);

// Names must be unique, or the catalogue would show two indistinguishable rows.
check("技能名唯一", new Set(names).size === names.length, names.join(", "));

// The entry must state the precedence the sub-skills do not state themselves.
const entryDescription = (entry?.description ?? "").replaceAll(/\s+/g, " ");
check(
  "入口技能给出三者优先级",
  /优先|先核坐标|先定边界|precedence/i.test(entryDescription),
  "各子技能只说自己何时用，没有说谁在先",
);

console.log(`catalog 常驻成本：四个技能 description 合计 ${totalRendered} 字符\n`);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
