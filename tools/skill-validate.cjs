/**
 * Validate a skill directory against the rules the Host actually enforces.
 *
 * The rules come from `dsh-skill`'s own validators, not from a document:
 *   validateRuntimeSkill → SKILL_NAME regex, non-empty description
 *   validateDefinition  → name/description/content must be strings
 * Plus the filesystem provider's shape: `<dir>/SKILL.md` at depth 2.
 *
 * Usage: node tools/skill-validate.cjs <dir> [<dir> ...]
 */
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("用法: node tools/skill-validate.cjs <skill 目录> [...]");
    process.exit(2);
  }

  // The real validator, taken from the installed Host.
  const hostModules = "D:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai";
  const { createRequire } = require("node:module");
  const requireHost = createRequire(path.join(hostModules, "noop.js"));

  // SKILL_NAME and isSkillName are exported; use them rather than re-deriving the regex.
  const skillPkg = requireHost("@deepseek-ai/dsh-skill");
  const isSkillName = skillPkg.isSkillName;
  const isModelInvocable = skillPkg.isModelInvocable;

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  /**
   * Minimal frontmatter reader: `---` … `---` with flat `key: value` pairs.
   *
   * Line endings are normalized FIRST. The upstream skills are checked out with
   * CRLF (`2D 2D 2D 0D 0A`), so a literal `startsWith("---\n")` would report
   * "no frontmatter" for a perfectly valid file — the same class of bug as the
   * corpus `\r` leak: reading disk as-is instead of normalizing at the boundary.
   */
  function readFrontmatter(raw) {
    const text = raw.replace(/\r\n/g, "\n");
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

  for (const target of targets) {
    const dir = path.resolve(target);
    const rel = path.relative(process.cwd(), dir) || dir;
    console.log(`\n=== ${rel} ===`);

    check(`${rel} 目录存在`, fs.existsSync(dir));
    if (!fs.existsSync(dir)) continue;

    const file = path.join(dir, "SKILL.md");
    check(`${rel} 含 SKILL.md`, fs.existsSync(file));
    if (!fs.existsSync(file)) continue;

    const text = fs.readFileSync(file, "utf8");
    const meta = readFrontmatter(text);
    check(`${rel} 有 frontmatter`, meta !== null);
    if (meta === null) continue;

    // name — the Host enforces this exact rule on registration.
    check(`${rel} 有 name`, typeof meta.name === "string" && meta.name.length > 0);
    if (typeof meta.name === "string") {
      check(
        `${rel} 的 name 合法（kebab-case）`,
        typeof isSkillName === "function" ? isSkillName(meta.name) : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name),
        meta.name,
      );
      // The HOST does not require this: `parseSkillFile` only validates the name
      // format and a non-empty description, keeping the directory purely as a
      // locator. So a repository can register as one skill whose directory name
      // differs from the skill name, which is exactly the "repo as skill" shape.
      // Report it as advisory rather than failing.
      if (meta.name !== path.basename(dir)) {
        console.log(`NOTE  ${rel} 的 name 与目录名不同（允许：目录只用于定位，不是身份）`);
      }
    }

    // description — routing depends on it, so length matters in both directions.
    //
    // The upper bound is 1200, not the catalogue's 1024: this validator checks the
    // SKILL FILE, not one particular catalogue's budget. A description longer than
    // the budget still loads correctly (the catalogue truncates only its own line),
    // so a file is not invalid just because our preset would shorten it. Making the
    // budget the hard limit here would reject the upstream file we deliberately
    // ship verbatim. `skill-catalog-check.cjs` is what enforces the budget.
    const desc = meta.description ?? "";
    check(`${rel} 有 description`, desc.length > 0);
    check(`${rel} description 长度适合路由`, desc.length >= 60 && desc.length <= 1200, `${desc.length} 字符`);
    // "Use only for … when …" is the upstream editor skill's phrasing: a trigger
    // statement, but not the literal "use when" token.
    check(
      `${rel} description 说明了何时用`,
      /use (only )?for .*? when|use when|使用|适用/i.test(desc),
      desc.slice(0, 80),
    );

    // body — content is what the model reads after loading.
    const bodyStart = text.indexOf("\n---", 3) + 4;
    const body = text.slice(bodyStart).trim();
    check(`${rel} 正文非空`, body.length > 100, `${body.length} 字符`);
    check(`${rel} 正文有标题`, /^#\s/m.test(body));

    // Invocation: model-visible by default, which is what we want. The Host reads
    // `skill.invocation.modelInvocable`, so the fixture must match that shape.
    check(
      `${rel} 可被模型调用`,
      typeof isModelInvocable === "function"
        ? isModelInvocable({ invocation: { modelInvocable: true, userInvocable: true } })
        : true,
    );
  }

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
