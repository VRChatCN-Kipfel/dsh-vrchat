/**
 * Print the exact catalogue lines the model will see for the vendored skills.
 *
 * Mirrors dsh-skill-filesystem's discovery rules (a directory's `SKILL.md` is one
 * skill; a root-level `*.md` is one skill whose resourceBase is the whole root) and
 * dsh-tool-skill's renderer (`- \`name\`: description`, whitespace collapsed,
 * truncated to catalogDescriptionMaxLength). Nothing here is a re-implementation of
 * policy — it is a printer for a value that otherwise only exists in a live session.
 *
 * Usage: node tools/show-skill-catalog.cjs [--limit N]
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.join(__dirname, "..");
const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");
const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value) => value, identify: () => false };

/** The limit this preset actually configures, not the reader's default. */
function configuredLimit() {
  const patch = YAML.parse(fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8"), { customTags: [jsTag] });
  const preset = patch[0].insert.find((row) => row.id === "preset-vrchat");
  const reader = preset?.config?.plugins?.find((plugin) => plugin.id === "tool-skill");
  return reader?.config?.catalogDescriptionMaxLength ?? 500;
}

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  return YAML.parse(text.slice(4, end));
}

/** One root's skills, by the provider's own shape rules. */
function discover(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const isFile = fs.statSync(full).isFile();
    const file = isFile && name.endsWith(".md") ? full : path.join(full, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const meta = frontmatter(file);
    if (meta === null || typeof meta.name !== "string" || typeof meta.description !== "string") continue;
    found.push({ name: meta.name, description: meta.description });
  }
  return found;
}

const limit = Number(process.argv[2] ?? configuredLimit());
const roots = [
  ["vendor/vrchat-world-codex-skills", path.join(ROOT, "vendor", "vrchat-world-codex-skills")],
  ["vendor/vrchat-editor-skill", path.join(ROOT, "vendor", "vrchat-editor-skill")],
];

let total = 0;
for (const [label, dir] of roots) {
  console.log(`\n=== ${label}`);
  for (const skill of discover(dir)) {
    const collapsed = skill.description.replaceAll(/\s+/g, " ").trim();
    const rendered = collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
    total += rendered.length;
    const mark = collapsed.length > limit ? `  ⚠ 截断 ${collapsed.length}→${limit}` : "";
    console.log(`- \`${skill.name}\`: ${rendered}${mark}`);
  }
}
console.log(`\n共 ${roots.reduce((n, [, dir]) => n + discover(dir).length, 0)} 个技能，常驻 ${total} 字符（上限 ${limit}）`);
