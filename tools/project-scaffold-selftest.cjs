/**
 * Self-test for the project scaffolder. Uses a temp dir under the repo's cache
 * area; every case asserts on REAL filesystem state, not on the module's opinion.
 *
 * Usage: node tools/project-scaffold-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "project-scaffold.js")).href);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vrchat-scaffold-"));
  const cleanup = () => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* Windows may hold a handle; the temp dir is disposable either way */
    }
  };

  try {
    // ── 1. clean create ────────────────────────────────────────────────────
    const target = path.join(base, "MyWorld");
    const plan = mod.planProject({ targetDir: target, type: "world" });
    check("干净目标 → status=absent", plan.status === "absent", plan.status);
    check("默认 Unity 版本", plan.unityVersion === "2022.3.22f1", plan.unityVersion);
    check("world 解析到 com.vrchat.worlds", plan.resolvedSdk === "com.vrchat.worlds", plan.resolvedSdk);

    const result = mod.applyProject(plan);
    check("目标目录已创建", fs.existsSync(target));
    for (const dir of ["Assets", "ProjectSettings", "Packages"]) {
      check(`目录 ${dir}/ 存在`, fs.statSync(path.join(target, dir)).isDirectory());
    }

    const pv = fs.readFileSync(path.join(target, "ProjectSettings", "ProjectVersion.txt"), "utf8");
    check("ProjectVersion.txt 内容正确", pv.trim() === "m_EditorVersion: 2022.3.22f1", pv.trim());

    const manifest = JSON.parse(fs.readFileSync(path.join(target, "Packages", "manifest.json"), "utf8"));
    check("manifest.json 有 dependencies", typeof manifest.dependencies === "object");
    check(
      "manifest.json 依赖数与官方模板一致（36）",
      Object.keys(manifest.dependencies).length === 36,
      String(Object.keys(manifest.dependencies).length),
    );
    check("manifest 含 collab-proxy", manifest.dependencies["com.unity.collab-proxy"] === "2.3.1");
    check("manifest 含 ugui", manifest.dependencies["com.unity.ugui"] === "1.0.0");

    const vpm = JSON.parse(fs.readFileSync(path.join(target, "Packages", "vpm-manifest.json"), "utf8"));
    check(
      "vpm-manifest.json 写的是 worlds 3.x",
      vpm.dependencies["com.vrchat.worlds"]?.version === "3.x",
      JSON.stringify(vpm.dependencies),
    );
    check("没有写 avatars 依赖", vpm.dependencies["com.vrchat.avatars"] === undefined);

    // The whole point of choosing the Blank path: Unity-owned YAML is NOT faked.
    check(
      "没有伪造 ProjectSettings.asset",
      !fs.existsSync(path.join(target, "ProjectSettings", "ProjectSettings.asset")),
    );
    check(
      "没有伪造 InputManager.asset",
      !fs.existsSync(path.join(target, "ProjectSettings", "InputManager.asset")),
    );
    check("没有残留 .tmp 目录", !fs.readdirSync(base).some((n) => n.includes(".tmp-")));
    check("apply 报告了 backup=null", result.backup === null);

    // ── 2. avatar differs in exactly one place ─────────────────────────────
    const avatarTarget = path.join(base, "MyAvatar");
    mod.applyProject(mod.planProject({ targetDir: avatarTarget, type: "avatar" }));
    const avatarVpm = JSON.parse(
      fs.readFileSync(path.join(avatarTarget, "Packages", "vpm-manifest.json"), "utf8"),
    );
    check(
      "avatar 工程写 avatars 3.x",
      avatarVpm.dependencies["com.vrchat.avatars"]?.version === "3.x",
      JSON.stringify(avatarVpm.dependencies),
    );
    const avatarManifest = JSON.parse(
      fs.readFileSync(path.join(avatarTarget, "Packages", "manifest.json"), "utf8"),
    );
    check(
      "world 与 avatar 的 manifest.json 完全相同",
      JSON.stringify(avatarManifest) === JSON.stringify(manifest),
      "两者只有 vpm-manifest.json 不同（已由上游模板核对）",
    );

    // ── 3. existing directory is refused, not overwritten ──────────────────
    let refused = null;
    try {
      mod.planProject({ targetDir: target, type: "world" });
    } catch (e) {
      refused = e;
    }
    check("再次建同名工程被拒绝", refused !== null && refused.code === "already-a-project", refused?.code);
    check("拒绝信息里列出了目录内容", typeof refused?.detail?.contents === "string" && refused.detail.contents.length > 0);
    check("原工程未被破坏（ProjectVersion.txt 仍在）", fs.existsSync(path.join(target, "ProjectSettings", "ProjectVersion.txt")));

    // ── 4. plain non-project dir also refused ──────────────────────────────
    const plain = path.join(base, "PlainDir");
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "important.txt"), "do not lose me");
    let refusedPlain = null;
    try {
      mod.planProject({ targetDir: plain, type: "world" });
    } catch (e) {
      refusedPlain = e;
    }
    check("非工程目录也被拒绝", refusedPlain?.code === "already-exists", refusedPlain?.code);

    // ── 5. force backs up instead of deleting ──────────────────────────────
    const forced = mod.planProject({ targetDir: plain, type: "avatar", force: true });
    check("force 计划里有备份路径", typeof forced.backupDir === "string");
    const forcedResult = mod.applyProject(forced);
    check("force 后原文件被移到备份", fs.existsSync(path.join(forcedResult.backup, "important.txt")));
    check("force 后目标已是工程", fs.existsSync(path.join(plain, "ProjectSettings", "ProjectVersion.txt")));
    const backedUp = fs.readFileSync(path.join(forcedResult.backup, "important.txt"), "utf8");
    check("备份内容完好", backedUp === "do not lose me", backedUp);

    // ── 6. bad inputs are refused with specific codes ──────────────────────
    const cases = [
      [{ targetDir: "", type: "world" }, "bad-path"],
      [{ targetDir: path.join(base, "x"), type: "scene" }, "bad-type"],
      [{ targetDir: path.join(base, "y"), type: "world", unityVersion: "2022.3" }, "bad-unity-version"],
      [{ targetDir: path.join(base, "y"), type: "world", unityVersion: "latest" }, "bad-unity-version"],
      [{ targetDir: path.join(base, "a", "b", "c"), type: "world" }, "parent-missing"],
    ];
    for (const [options, expected] of cases) {
      let err = null;
      try {
        mod.planProject(options);
      } catch (e) {
        err = e;
      }
      check(`拒绝 ${JSON.stringify(options).slice(0, 52)} → ${expected}`, err?.code === expected, err?.code);
    }

    // ── 7. summary states what was NOT written ─────────────────────────────
    const text = mod.summarize(plan, result);
    check("摘要写明 SDK 未安装", text.includes("SDK 还没装"));
    check("摘要给出 resolve 命令", text.includes("vrc-get resolve"));
    check("摘要声明未写 InputManager.asset", text.includes("InputManager.asset"));
  } finally {
    cleanup();
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
  console.error("SELFTEST FAILED:", error?.stack ?? error);
  process.exit(1);
});
