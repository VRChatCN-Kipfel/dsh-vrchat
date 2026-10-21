/**
 * Verify the installed generation can actually LOAD — the exact failure that
 * took DSH down once. Runs against the live generation directory, not the
 * workspace, so it exercises the real resolution paths (including `zod`, which
 * only exists inside the installed tree).
 *
 * Usage: node tools/verify-installed.cjs [generationName]
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const generationsLib = require("./lib-generation.cjs");

const generations = generationsLib.liveRoot();

/**
 * Pick a generation. Default is the NEWEST BY MTIME, never the name-sorted last:
 * names embed a version, so string sorting puts `0.9.0` after `0.11.0` and a
 * name-sorted pick silently verifies a stale generation while reporting success.
 */
function pickGeneration(name) {
  if (!fs.existsSync(generations)) return null;
  if (name !== undefined) {
    const match = fs
      .readdirSync(generations)
      .find((entry) => entry.startsWith("dsh-vrchat-kb+") && entry.includes(name));
    return match ?? null;
  }
  return generationsLib.newestGeneration("dsh-vrchat-kb+");
}

async function main() {
  const name = pickGeneration(process.argv[2]);
  if (name === null) {
    console.log("找不到已安装代");
    process.exitCode = 1;
    return;
  }
  const pkgRoot = path.join(generations, name, "node_modules", "dsh-vrchat-kb");
  console.log(`代: ${name}`);

  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok, detail });

  // 1. every shipped module parses as ESM
  for (const rel of ["lib/ledger.js", "lib/lint.js", "lib/docs.js", "lib/search.js"]) {
    const full = path.join(pkgRoot, rel);
    try {
      const mod = await import(pathToFileURL(full).href);
      check(`${rel} 可加载`, true, Object.keys(mod).length + " exports");
    } catch (error) {
      check(`${rel} 可加载`, false, String(error?.message ?? error));
    }
  }

  // 2. zod resolves from the INSTALLED tree (the workspace lacks it)
  const zodDir = path.join(generations, name, "node_modules", "zod");
  check("zod 随包安装", fs.existsSync(zodDir), zodDir.length > 0 ? "present" : "missing");
  if (fs.existsSync(zodDir)) {
    try {
      const zod = await import(pathToFileURL(path.join(zodDir, "index.js")).href);
      const api = zod.z ?? zod.default;
      check("zod 提供 object()", typeof api?.object === "function");
      const schema = api.object({ a: api.number() });
      check("zod schema 可解析", schema.parse({ a: 1 }).a === 1);
    } catch (error) {
      check("zod 可加载", false, String(error?.message ?? error));
    }
  }

  // 3. data/ completeness — the guard's precondition
  const dataDir = path.join(pkgRoot, "data");
  // Shipped artifacts only. `pages.json` is intentionally absent: bodies are
  // read lazily from the workspace checkout.
  for (const file of [
    "t0-core.txt",
    "always-load.txt",
    "domain-map.txt",
    "keyword-routes.json",
    "index.json",
    "manifest.json",
    "api-table.json",
  ]) {
    check(`data/${file}`, fs.existsSync(path.join(dataDir, file)));
  }
  check("data/pages.json 不再随包", !fs.existsSync(path.join(dataDir, "pages.json")));

  // 4. index.js must not be importable without the Harness (it imports its
  // packages), but a syntax-level parse still catches broken edits.
  const indexSource = fs.readFileSync(path.join(pkgRoot, "index.js"), "utf8");
  check("index.js 含 apply 导出", /export\s*\{[^}]*apply/.test(indexSource));
  check("index.js 注册投影", /sessionProjections/.test(indexSource));
  check("index.js 含 ledger 导入", /from "\.\/lib\/ledger\.js"/.test(indexSource));

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
