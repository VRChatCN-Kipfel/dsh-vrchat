/**
 * Print the exact catalogue lines the model will see for the vendored skills.
 *
 * Mirrors dsh-skill-filesystem's discovery rules (a directory's `SKILL.md` is one
 * skill; a root-level `*.md` is one skill whose resourceBase is the whole root) and
 * dsh-tool-skill's renderer (`- \`name\`: description`, whitespace collapsed,
 * truncated to catalogDescriptionMaxLength). Nothing here is a re-implementation of
 * policy — it is a printer for a value that otherwise only exists in a live session.
 *
 * The vendored roots are printed first because they are the part this repo owns and
 * the part a check can assert. With `includeDefaultRoots` at its documented default,
 * a live catalogue ALSO lists the user's own skills — the second section estimates
 * those, and the merged figure answers "what does this preset cost per turn".
 * Duplicates across providers are resolved first-wins by the registry, so the
 * estimated total can overstate; the merged section says so rather than pretending.
 *
 * Usage: node tools/show-skill-catalog.cjs [--limit N]
 */
const fs = require("node:fs");
const os = require("node:os");
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

/** Does the shipped patch still pin the default-roots switch? */
function shipsDefaultRoots() {
  const patch = YAML.parse(fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8"), { customTags: [jsTag] });
  const preset = patch[0].insert.find((row) => row.id === "preset-vrchat");
  const provider = preset?.config?.plugins?.find((plugin) => plugin.id === "vrchat-skills");
  return provider?.config?.includeDefaultRoots !== false;
}

function render(skill) {
  const collapsed = skill.description.replaceAll(/\s+/g, " ").trim();
  const rendered = collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
  const mark = collapsed.length > limit ? `  ⚠ 截断 ${collapsed.length}→${limit}` : "";
  return { text: `- \`${skill.name}\`: ${rendered}${mark}`, size: rendered.length, truncated: mark !== "" };
}

let total = 0;
let vendored = 0;
for (const [label, dir] of roots) {
  console.log(`\n=== ${label}`);
  for (const skill of discover(dir)) {
    const line = render(skill);
    total += line.size;
    vendored += 1;
    console.log(line.text);
  }
}
console.log(`\n随包技能 ${vendored} 个，常驻 ${total} 字符（上限 ${limit}）`);

// The live catalogue is this plus whatever the default roots hold. Report it so the
// cost shown here is the cost a session pays, not just the part we vendor.
if (!shipsDefaultRoots()) {
  console.log("\n（本预设把 includeDefaultRoots 关掉了：上面就是完整目录）");
} else {
  const defaultRoots = [
    ["~/.agents/skills", path.join(os.homedir(), ".agents", "skills")],
    ["$DSH_HOME/skills", path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "skills")],
  ];
  console.log("\n=== includeDefaultRoots 为默认 true，真实目录还包含这些根：");
  let extraTotal = 0;
  let extraCount = 0;
  for (const [label, dir] of defaultRoots) {
    const found = discover(dir);
    if (found.length === 0) continue;
    console.log(`\n--- ${label}（${found.length} 个）`);
    for (const skill of found) {
      const line = render(skill);
      extraTotal += line.size;
      extraCount += 1;
      console.log(line.text);
    }
  }
  console.log(
    `\n合计 ${vendored + extraCount} 个技能，常驻约 ${total + extraTotal} 字符。` +
      `\n其中随包 ${vendored} 个（本仓库可断言）／默认根 ${extraCount} 个（随机器而变）。` +
      `\n注意：默认根的技能若与标准 skill-filesystem 行重复，注册表按 first-wins 静默丢弃，` +
      `\n所以合并总量是上界；被丢弃的那些本来也不会重复计费。`,
  );
}
