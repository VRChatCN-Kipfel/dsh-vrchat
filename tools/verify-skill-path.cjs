/**
 * Verify each `!!js` path expression resolves to a directory that really holds
 * skills, from the INSTALLED package's location.
 *
 * The patch uses `new URL('vendor/<dir>/', baseUrl)`, where `baseUrl` is the patch
 * file's own location. Getting that base wrong is silent: the provider simply finds
 * no skills and the catalog comes up empty. Adding a second skill root doubles the
 * number of ways this can go wrong without adding any signal, so both roots are
 * resolved and their contents asserted here.
 *
 * Usage: node tools/verify-skill-path.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const generationsLib = require("./lib-generation.cjs");

/**
 * Each vendored skill root, plus the resources its entry file points at.
 *
 * The `expected` lists are not inventories — they are the files the entry SKILL.md
 * actually cites. A root that resolves but has lost its references still loads and
 * still advertises itself in the catalogue; only the follow-up read fails, later,
 * in a different turn. Checking them here keeps that failure at build time.
 */
const ROOTS = [
  {
    dir: "vendor/vrchat-world-codex-skills",
    expected: [
      "SKILL.md",
      "build-vrchat-world/SKILL.md",
      "design-modular-vrchat-world/SKILL.md",
      "coordinate-transform-audit/SKILL.md",
      "build-vrchat-world/references/unity-mcp-workflow.md",
      "design-modular-vrchat-world/references/module-model.md",
      "docs/RECOMMENDED_OPEN_SOURCE_SKILLS.md",
    ],
  },
  {
    dir: "vendor/vrchat-editor-skill",
    expected: [
      "SKILL.md",
      "references/toolchain-selection.md",
      "references/avatar-feature-routing.md",
      "references/audit-documentation-workflow.md",
      "references/evidence-and-authorization.md",
      "references/faceemo-playbook.md",
      "references/lilycal-inventory-playbook.md",
      "references/modular-avatar-playbook.md",
      "LICENSE",
    ],
  },
];

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
  console.log(`\nbaseUrl:  ${baseUrl.href}\n`);

  for (const root of ROOTS) {
    console.log(`--- ${root.dir}`);
    const resolved = fileURLToPath(new URL(`${root.dir}/`, baseUrl));
    console.log(`    解析结果: ${resolved}`);
    check(`[${root.dir}] 解析出的目录存在`, fs.existsSync(resolved), resolved);

    // ── 2. that directory must actually be a skill ─────────────────────
    const skillFile = path.join(resolved, "SKILL.md");
    check(`[${root.dir}] 目录内有 SKILL.md`, fs.existsSync(skillFile), skillFile);
    if (fs.existsSync(skillFile)) {
      // CRLF is normal here: git checks submodule files out with the host's
      // endings, so a literal `startsWith("---\n")` reports "no frontmatter"
      // for a perfectly valid file.
      const text = fs.readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n");
      check(`[${root.dir}] SKILL.md 有 frontmatter`, text.startsWith("---\n"));
      const nameMatch = /^name:\s*(.+)$/m.exec(text);
      const descMatch = /^description:\s*(.+)$/m.exec(text);
      check(`[${root.dir}] SKILL.md 有 name`, nameMatch !== null, nameMatch?.[1] ?? "");
      check(`[${root.dir}] SKILL.md 有 description`, descMatch !== null, (descMatch?.[1] ?? "").slice(0, 60));
      console.log(`    技能名: ${nameMatch?.[1] ?? "(缺)"}`);
    }

    // ── 3. the resources the entry skill points at must be there ───────
    for (const rel of root.expected) {
      check(`[${root.dir}] 资源存在：${rel}`, fs.existsSync(path.join(resolved, ...rel.split("/"))));
    }
  }

  // ── 4. package.json must ship both roots ───────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const files = pkg.files ?? [];
  for (const root of ROOTS) {
    check(
      `files 白名单含 ${root.dir}`,
      files.some((entry) => entry === root.dir || entry === "vendor"),
      files.join(", "),
    );
  }

  // ── 5. the persona names a recommended-skills doc; it must ship ─────────
  //
  // The PRESET persona tells the model to read this table before recommending any
  // third-party skill. `vendor/vrchat-world-codex-skills` is in the files whitelist
  // as a WHOLE directory, so losing `docs/` would not break the whitelist check —
  // and `cited-paths.cjs` only resolves paths inside the corpus, not vendor docs.
  // Without this the persona could point at a file that no longer exists and every
  // check would still pass: exactly the "declares what it cannot deliver" failure
  // this repo keeps running into.
  const personaPrefix = fs.readFileSync(path.join(pkgDir, "data", "persona-prefix.txt"), "utf8");
  const RECOMMENDED_DOC = "vendor/vrchat-world-codex-skills/docs/RECOMMENDED_OPEN_SOURCE_SKILLS.md";
  if (personaPrefix.includes(RECOMMENDED_DOC)) {
    check(
      `persona 引用的推荐表随包存在`,
      fs.existsSync(path.join(pkgDir, ...RECOMMENDED_DOC.split("/"))),
      RECOMMENDED_DOC,
    );
  } else {
    console.log(`注意：persona 未引用 ${RECOMMENDED_DOC}（本条跳过）`);
  }

  // ── 6. if the persona names the doc, it must name it with its real location ──
  //
  // A relative filename without the `vendor/` prefix would resolve against the
  // installed package root for a human but against the session cwd for the model.
  if (personaPrefix.includes("RECOMMENDED_OPEN_SOURCE_SKILLS.md")) {
    check(
      "推荐表被以包内相对路径引用（含 vendor/ 前缀）",
      personaPrefix.includes(RECOMMENDED_DOC),
      "缺 vendor/ 前缀时模型会按会话 cwd 去找",
    );
  }

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
