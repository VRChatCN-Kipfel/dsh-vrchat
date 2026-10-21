/**
 * Pre-install shape check: the things `defineTool` compilation does NOT cover
 * but that still throw inside `apply()` — and any throw in `apply()` during
 * startup takes the whole Harness down, because `auditStartupEntries` treats
 * every inactive entry as fatal at boot.
 *
 * Usage: node tools/check-shape.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check("导出 apply", /export\s*\{[^}]*\bapply\b/.test(source));
check("导出 inject", /export\s*\{[^}]*\binject\b/.test(source));
check("导出 name", /export\s*\{[^}]*\bname\b/.test(source));
check("导出 Config", /export\s*\{[^}]*\bConfig\b/.test(source));
check("inject 是数组（不是 required/optional 对象）", /const inject\s*=\s*\[/.test(source));

// Optional services must go through ctx.get, never the inject list.
const injected = /const inject\s*=\s*\[([^\]]*)\]/.exec(source);
const injectNames = injected === null ? [] : injected[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
const gotNames = [...new Set([...source.matchAll(/ctx\.get\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))];
check("inject 只含必需服务", injectNames.every((n) => !gotNames.includes(n)), `inject=${injectNames.join(",")} 可选=${gotNames.join(",")}`);

// Every ctx.get() site must be guarded: an undefined optional service must not
// be dereferenced immediately.
for (const name of gotNames) {
  const guarded = new RegExp(`(?:!==\\s*undefined|=== undefined|\\?\\.)`).test(source);
  check(`可选服务 ${name} 有空值检查`, guarded);
}

// data/ files the plugin reads at apply() time must exist in the package.
// Only artifacts the bundle still ships. `pages.json` is deliberately absent:
// page bodies live in the workspace checkout and are read lazily.
const requiredData = ["t0-core.txt", "always-load.txt", "domain-map.txt", "keyword-routes.json", "index.json", "manifest.json", "api-table.json"];
check("不再要求随包 pages.json", !requiredData.includes("pages.json"), "正文改为惰性读 checkout");
const dataDir = path.join(__dirname, "..", "data");
for (const file of requiredData) {
  check(`data/${file} 存在`, fs.existsSync(path.join(dataDir, file)));
}

// package.json `files` must ship everything index.js imports at runtime.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const shipped = new Set(pkg.files ?? []);
const imports = [...source.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((m) => m[1]);
for (const rel of imports) {
  const top = rel.split("/")[0];
  check(`files 含 ${top}`, shipped.has(top) || shipped.has(rel), `import ${rel}`);
}
check("files 含 index.js", shipped.has("index.js"));
check("files 含 data", shipped.has("data"));

// The corpus is the plugin BODY, not an optional extra: if `files` omits it the
// install is silently truncated and every retrieval tool returns "corpus
// missing". This was a real failure — the package installed with no pages.
check(
  "files 含语料目录",
  shipped.has("VRChat-Agent-Creator-Library"),
  [...shipped].join(", "),
);
check(
  "语料目录实际存在",
  fs.existsSync(path.join(root, "VRChat-Agent-Creator-Library", "memoryV5.0.0")),
);

// ── every bare import in the HOST half must be declared or Host-provided ───
// A bare import that is neither declared nor shipped by the Host resolves to
// undefined at `apply()` — and a throw in `apply()` fails Harness startup, so
// this is a crash-class check, not a tidiness one.
//
// `client.js` is excluded on purpose: it runs in the browser module table where
// `require("react")` is provided by the page, not by npm.
const hostFiles = ["index.js", ...fs.readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`)];
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

/**
 * Bare module specifiers of real import/export statements only.
 *
 * Anchoring to the STATEMENT (start of line, optional leading whitespace) is
 * required: a looser `from "..."` search also matches prose in comments, e.g.
 * `...stops a question from "matching" an Avatar page`, and that produced a
 * bogus undeclared-dependency failure.
 */
const bareImportsOf = (text) =>
  [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"'.][^"']*)["']/gm)]
    .map((m) => m[1])
    .filter((spec) => /^(@[a-z0-9-]+\/)?[a-z0-9-_.]+$/i.test(spec));

for (const rel of hostFiles) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  for (const spec of new Set(bareImportsOf(text))) {
    if (spec.startsWith("@deepseek-ai/")) continue; // resolved by the Host module fallback
    check(`${rel} 的依赖 ${spec} 已声明`, declared.has(spec), [...declared].join(", "));
  }
}

// The manifest must not declare what nothing uses: it slows installation and
// hides which dependency actually matters.
const allHostText = hostFiles.map((rel) => fs.readFileSync(path.join(root, rel), "utf8")).join("\n");
for (const name of declared) {
  const pattern = new RegExp(`\\bfrom\\s+["']${name.replace(/[/@.]/g, "\\$&")}["']`);
  check(`依赖 ${name} 确实被使用`, pattern.test(allHostText), "未使用的依赖应从 dependencies 移除");
}

// The build tool reads `yaml` from the DSH installation (it is a Host
// dependency), not from this package, so it must not appear in dependencies.
check("yaml 不在运行时依赖里", !declared.has("yaml"), [...declared].join(", "));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  const detail = item.detail === undefined ? "" : `  (${item.detail})`;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${detail}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
