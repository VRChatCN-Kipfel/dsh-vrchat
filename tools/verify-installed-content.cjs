/**
 * Verify the INSTALLED generation carries the capability-gap section and no
 * longer ships the removed connector modules.
 *
 * Reads the installed patch with the real parser, which is also the check that
 * matters: the preset only activates if the YAML parses.
 *
 * Usage: node tools/verify-installed-content.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadFromHost } = require("./lib-host-require.cjs");
const requireFromProfile = loadFromHost;
const YAML = requireFromProfile("yaml");

const generations = require("./lib-generation.cjs");
const target = generations.newestGeneration("dsh-vrchat+");
if (target === null) {
  console.log("找不到已安装代");
  process.exit(1);
}
const pkgRoot = path.join(generations.liveRoot(), target, "node_modules", "dsh-vrchat");
console.log(`代: ${target}`);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// ── removed modules must be gone ────────────────────────────────────────
for (const rel of ["lib/connector.js", "lib/patch-write.js"]) {
  check(`${rel} 不再随包`, !fs.existsSync(path.join(pkgRoot, rel)));
}

// ── the installed patch parses and carries both new sections ────────────
let patch;
try {
  patch = YAML.parse(fs.readFileSync(path.join(pkgRoot, "cordis.patch.yml"), "utf8"));
  check("已安装 patch 可解析", Array.isArray(patch));
} catch (error) {
  check("已安装 patch 可解析", false, String(error?.message ?? error));
}

if (Array.isArray(patch)) {
  // The persona lives in the PRESET row. Row 0 is the always-on tools-only
  // mount, which carries no prompt text at all — reading it finds nothing.
  const presetRow = patch[0]?.insert?.find((row) => row.id === "preset-vrchat");
  const persona = presetRow?.config?.plugins?.find((plugin) => plugin.id === "persona");
  const prefix = persona?.config?.prefix ?? "";
  check("预设行存在", presetRow !== undefined);
  check("prefix 非空", prefix.length > 1000, `${prefix.length} 字符`);

  check("含开工前盘点段", /开工前先盘点/.test(prefix));
  check("含自主边界段", /你的自主边界/.test(prefix));
  check("自主面含改 manifest.json", /Packages\/manifest\.json/.test(prefix));
  check("自主面含 install-unity", /install-unity/.test(prefix));
  check("自主面含无头启动", /--headless/.test(prefix));
  check("给出两个 Unity MCP 桥", /IvanMurzak\/Unity-MCP/.test(prefix) && /CoplayDev\/unity-mcp/.test(prefix));
  check("判据是用户能否配合", /用户能不能配合/.test(prefix));
  check("OAuth 是唯一必须用户的一步", /OAuth/.test(prefix));
  check("不再断言 manifest 必须手点", !/都必须由用户在 Unity 里点/.test(prefix));
  check("提到 BOOTHVAULT_TOOLHUB", /BOOTHVAULT_TOOLHUB/.test(prefix));
  check("BOOTH 需要 cookie 且不许伪造", /cookie/.test(prefix) && /不要伪造/.test(prefix));
  check("不假设管理工具存在", /不要假设某个管理工具一定存在/.test(prefix));
  check("禁止改用户 profile", /不要在会话里直接改用户的 profile/.test(prefix));
  check("三件事格式", /缺什么/.test(prefix) && /装了能多得到什么/.test(prefix) && /还能做什么/.test(prefix));
  check("不再提 vrchat_kb_connect", !/vrchat_kb_connect/.test(prefix));
}

// ── the RUNTIME must not need yaml; the INSTALL does ─────────────────────
//
// This used to assert `dependencies.yaml === undefined`, i.e. "yaml is not a
// dependency". The intent behind it was that the SHIPPED PLUGIN reads no YAML: it
// works off a pre-rendered patch, not a parsed one. Checking the dependency LIST was
// only ever a proxy for that intent, and it has stopped being a valid one.
//
// `yaml` is now a declared dependency on purpose. `tools/prepare.js` runs during
// `npm install` on the USER's machine and rebuilds `data/`; that machine has no DSH
// tree to borrow `yaml` from, so the dependency is what makes installation possible
// at all. Keeping the old assertion would force a choice between installing and
// passing the check.
//
// So this now tests the REAL property instead of the proxy: no runtime file may
// import yaml. That still holds, and it will fail if someone ever makes index.js or
// lib/ parse YAML at load time — which is the thing the original check cared about.
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
check("声明了 zod 依赖", pkg.dependencies?.zod !== undefined, JSON.stringify(pkg.dependencies ?? {}));
check(
  "yaml 作为依赖存在（prepare 在用户机器上需要它）",
  pkg.dependencies?.yaml !== undefined,
  JSON.stringify(pkg.dependencies ?? {}),
);

const libDir = path.join(pkgRoot, "lib");
const runtimeFiles = ["index.js", "client.js"]
  .map((rel) => path.join(pkgRoot, rel))
  .concat(
    fs.existsSync(libDir)
      ? fs
          .readdirSync(libDir)
          .filter((name) => name.endsWith(".js"))
          .map((name) => path.join(libDir, name))
      : [],
  );
const yamlImporters = runtimeFiles.filter((file) =>
  /require\(["']yaml["']\)|from\s+["']yaml["']/.test(fs.readFileSync(file, "utf8")),
);
check(
  "运行时文件不导入 yaml（yaml 只服务构建与安装）",
  yamlImporters.length === 0,
  yamlImporters.map((f) => path.basename(f)).join(", ") || "干净的",
);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
