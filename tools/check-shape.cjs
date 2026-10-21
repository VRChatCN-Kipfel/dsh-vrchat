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

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

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
const requiredData = ["t0-core.txt", "always-load.txt", "domain-map.txt", "keyword-routes.json", "index.json", "pages.json", "manifest.json"];
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

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  const detail = item.detail === undefined ? "" : `  (${item.detail})`;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${detail}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
