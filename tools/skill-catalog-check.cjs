/**
 * Verify every skill's description survives the catalogue's rendering.
 *
 * The catalogue shows the model one line per skill — `- \`name\`: description` —
 * with whitespace collapsed and the text truncated at `catalogDescriptionMaxLength`.
 * That line is the ENTIRE routing signal: the body is only read after the model
 * decides to load the skill. Two failure modes follow, and both are silent:
 *
 *   · exceeding the limit  → the tail is cut, so whatever was placed last never
 *                            reaches the model. Anything stated after the limit may
 *                            as well not be written.
 *   · too short            → nothing is cut, but the line stops naming its
 *                            trigger conditions and the model has to guess.
 *
 * So this checks the rendered length, that the description names when to use the
 * skill, and that it states at least one exclusion where the skill has
 * neighbouring skills to be confused with.
 *
 * The limit is NOT the reader's default (500). Our preset raises it to 1024 for its
 * own `tool-skill` row, and the vendored editor skill needs 795 characters to reach
 * its "Do not use for VRChat World or Udon" exclusion. Measuring against the default
 * would report a truncation that does not happen; measuring against nothing would
 * miss the day the configured limit stops covering the longest description.
 *
 * Usage: node tools/skill-catalog-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.join(__dirname, "..");

/**
 * The catalogue limit, read from the patch we actually ship.
 *
 * Hardcoding 1024 here would let the check and the preset drift apart: raise the
 * config, forget the checker, and a description that gets truncated still passes.
 */
function configuredCatalogLimit() {
  const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
  const YAML = requireFromProfile("yaml");
  // `!!js` is an application tag. Parsing without it resolves to a plain string and
  // emits a warning per occurrence, which turns a clean check into four lines of
  // noise above the results — and noise is how a real warning gets ignored.
  const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value) => value, identify: () => false };
  const patch = YAML.parse(fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8"), { customTags: [jsTag] });
  const preset = patch[0].insert.find((row) => row.id === "preset-vrchat");
  const reader = (preset?.config?.plugins ?? []).find((plugin) => plugin.id === "tool-skill");
  return reader?.config?.catalogDescriptionMaxLength ?? 500;
}

const CATALOG_LIMIT = configuredCatalogLimit();

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

/** Frontmatter of a repo-root skill file, or null. */
function entryOf(dir, rel) {
  const file = path.join(dir, ...rel.split("/"));
  return fs.existsSync(file) ? frontmatter(file) : null;
}

const WORLDS = path.join(ROOT, "vendor", "vrchat-world-codex-skills");
const EDITOR = path.join(ROOT, "vendor", "vrchat-editor-skill");

// Each root contributes its own candidates: the World root is one entry skill that
// routes to three sub-skills, the editor root is a single self-contained skill.
const WORLDS_CANDIDATES = [
  "SKILL.md",
  "build-vrchat-world/SKILL.md",
  "design-modular-vrchat-world/SKILL.md",
  "coordinate-transform-audit/SKILL.md",
];
const EDITOR_CANDIDATES = ["SKILL.md"];

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const names = [];
let totalRendered = 0;

/** Run the four routing checks that apply to every skill, and collect the name. */
function inspect(meta) {
  names.push(meta.name);
  const collapsed = (meta.description ?? "").replaceAll(/\s+/g, " ").trim();
  totalRendered += Math.min(collapsed.length, CATALOG_LIMIT);

  // 1. It must fit, or text is silently discarded.
  check(
    `${meta.name} 描述不超过 catalog 上限`,
    collapsed.length <= CATALOG_LIMIT,
    `${collapsed.length} / ${CATALOG_LIMIT}${collapsed.length > CATALOG_LIMIT ? " — 超出部分模型看不到" : ""}`,
  );

  // 2. It must be long enough to say something routable.
  check(`${meta.name} 描述足够长`, collapsed.length >= 80, `${collapsed.length} 字符`);

  // 3. It must name when to use it, not just what it does.
  //
  // The upstream editor skill phrases this as "Use only for VRChat Avatar work
  // when Codex receives a new avatar, …", which is a trigger statement but not the
  // exact "use when" token. Matching only the literal phrase would report a real
  // routing failure that does not exist, and the cheap way to silence it — editing
  // the submodule — is the thing this whole design is avoiding.
  check(
    `${meta.name} 描述含触发条件`,
    /use (only )?for .*? when|use when|适用于|当.*?时|when .*? (needed|required)|从这里 (开始|进)/i.test(collapsed),
    collapsed.slice(0, 60),
  );

  // 4. Neighbouring skills must each state an exclusion, or they get picked wrongly.
  check(
    `${meta.name} 描述含排除条件`,
    /not (need|for|use)|do not use|不适用|不必|skip/i.test(collapsed),
    collapsed.slice(-60),
  );
}

for (const rel of WORLDS_CANDIDATES) {
  const meta = entryOf(WORLDS, rel);
  if (meta !== null) inspect(meta);
}

for (const rel of EDITOR_CANDIDATES) {
  const meta = entryOf(EDITOR, rel);
  if (meta !== null) inspect(meta);
}

check("World 根下四个技能全部找到", WORLDS_CANDIDATES.every((rel) => entryOf(WORLDS, rel) !== null), WORLDS_CANDIDATES.join(", "));
check("编辑器根下技能找到", EDITOR_CANDIDATES.every((rel) => entryOf(EDITOR, rel) !== null), EDITOR_CANDIDATES.join(", "));
// 5 = the five skill files we ship in the two vendored roots. It is deliberately NOT
// the catalogue total: the provider keeps its documented `includeDefaultRoots`
// default, so a live session also lists whatever the user has in ~/.agents/skills,
// and the count there is a property of the machine, not of this repo.
check("随包技能总数是 5", names.length === 5, names.join(", "));

// The two roots must not collide: a duplicate name is dropped by first-wins, so the
// catalogue would silently show four rows and the fifth file would never load.
check("跨根技能名不重复", new Set(names).size === names.length, names.join(", "));

// The World entry skill must be distinguishable from the three it routes to.
const entry = frontmatter(path.join(WORLDS, "SKILL.md"));
check("入口技能名为 vrchat-world", entry?.name === "vrchat-world", String(entry?.name));
check(
  "入口技能名不含工具/仓库后缀",
  entry?.name !== undefined && !/(codex|skills|repo)$/i.test(entry.name),
  String(entry?.name),
);

// The entry must state the precedence the sub-skills do not state themselves.
const entryDescription = (entry?.description ?? "").replaceAll(/\s+/g, " ");
check(
  "入口技能给出三者优先级",
  /优先|先核坐标|先定边界|precedence/i.test(entryDescription),
  "各子技能只说自己何时用，没有说谁在先",
);

// The editor skill must exclude the World domain explicitly. It is the skill most
// likely to be picked for a World request, because its description names Animator,
// parameters, previews and builds — all generic Unity words.
const editor = frontmatter(path.join(EDITOR, "SKILL.md"));
check(
  "编辑器技能明确排除 World/Udon",
  /not (need|for|use)|do not use|不适用/i.test((editor?.description ?? "").replaceAll(/\s+/g, " ")) &&
    /World|Udon/i.test(editor?.description ?? ""),
  (editor?.description ?? "").slice(-60),
);

console.log(`catalog 常驻成本：${names.length} 个技能 description 合计 ${totalRendered} 字符（上限 ${CATALOG_LIMIT}）\n`);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
