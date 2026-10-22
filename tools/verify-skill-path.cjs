/**
 * Verify the `!!js` path expression resolves to a directory that really holds
 * the skills, from the INSTALLED package's location.
 *
 * The patch uses `new URL('vendor/vrchat-world-codex-skills/', baseUrl)`, where
 * `baseUrl` is the patch file's own location. Getting that base wrong is silent:
 * the provider simply finds no skills and the catalog comes up empty.
 *
 * Usage: node tools/verify-skill-path.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const generationsLib = require("./lib-generation.cjs");

async function main() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── 1. the expression, evaluated exactly as the Loader would ────────────
  //
  // The Loader evaluates the `!!js` expression with `baseUrl` in scope. The base
  // is the patch file's own path, so resolve it the same way.
  const generation = generationsLib.newestGeneration("dsh-vrchat-kb+");
  check("找到已安装代", generation !== null, String(generation));
  if (generation === null) {
    report();
    return;
  }

  const pkgDir = path.join(generationsLib.liveRoot(), generation, "node_modules", "dsh-vrchat-kb");
  const patchFile = path.join(pkgDir, "cordis.patch.yml");
  check("已安装 patch 存在", fs.existsSync(patchFile));

  const baseUrl = pathToFileURL(patchFile);
  const resolved = fileURLToPath(new URL("vendor/vrchat-world-codex-skills/", baseUrl));
  console.log(`\nbaseUrl:  ${baseUrl.href}`);
  console.log(`解析结果: ${resolved}\n`);

  check("解析出的目录存在", fs.existsSync(resolved), resolved);

  // ── 2. that directory must actually be a skill ─────────────────────────
  const skillFile = path.join(resolved, "SKILL.md");
  check("目录内有 SKILL.md", fs.existsSync(skillFile), skillFile);
  if (fs.existsSync(skillFile)) {
    const text = fs.readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n");
    check("SKILL.md 有 frontmatter", text.startsWith("---\n"));
    const nameMatch = /^name:\s*(.+)$/m.exec(text);
    const descMatch = /^description:\s*(.+)$/m.exec(text);
    check("SKILL.md 有 name", nameMatch !== null, nameMatch?.[1] ?? "");
    check("SKILL.md 有 description", descMatch !== null, (descMatch?.[1] ?? "").slice(0, 60));
    console.log(`技能名: ${nameMatch?.[1] ?? "(缺)"}`);
  }

  // ── 3. the resources the entry skill points at must be there ───────────
  const expected = [
    "build-vrchat-world/SKILL.md",
    "design-modular-vrchat-world/SKILL.md",
    "coordinate-transform-audit/SKILL.md",
    "build-vrchat-world/references/unity-mcp-workflow.md",
    "design-modular-vrchat-world/references/module-model.md",
    "docs/RECOMMENDED_OPEN_SOURCE_SKILLS.md",
  ];
  for (const rel of expected) {
    check(`资源存在：${rel}`, fs.existsSync(path.join(resolved, ...rel.split("/"))));
  }

  // ── 4. package.json must ship it ──────────────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const files = pkg.files ?? [];
  check(
    "files 白名单含 vendor 技能目录",
    files.some((entry) => entry === "vendor/vrchat-world-codex-skills" || entry === "vendor"),
    files.join(", "),
  );

  report();

  function report() {
    let failed = 0;
    for (const item of checks) {
      if (!item.ok) failed++;
      console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
    }
    console.log("");
    console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
