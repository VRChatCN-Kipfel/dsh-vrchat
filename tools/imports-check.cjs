/**
 * Verify that every symbol index.js imports from `lib/` actually exists, and
 * that every symbol it USES from those modules is imported.
 *
 * WHY THIS EXISTS: an import can be lost without any existing gate noticing.
 *   · `node --check` sees valid syntax — a missing import is not a syntax error.
 *   · `validate-schemas` runs `apply()`, but `initLedger`, `applyLedger`,
 *     `buildIndex` and `lookup` are all called from LAZY callbacks
 *     (projection `init`/`apply`, tool `execute`), so `apply()` succeeds while
 *     every one of those tools throws ReferenceError the first time it is used.
 *
 * That combination is a landmine: the plugin activates, the tool list looks
 * right, and the failure only appears in a live call. This check closes it by
 * comparing the module exports against index.js's import list and its usages.
 *
 * Usage: node tools/imports-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

/** `export function name` / `export const name` names of one module. */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name.length > 0) names.add(name);
    }
  }
  return names;
}

/** Names index.js imports from `./lib/<file>`. */
function importedFrom(source, file) {
  const names = new Set();
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']\\.\\/lib\\/${escaped}["']`, "g");
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name.length > 0) names.add(name);
    }
  }
  return names;
}

async function main() {
  const index = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const libDir = path.join(ROOT, "lib");
  const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith(".js"));

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  for (const file of libFiles) {
    const source = fs.readFileSync(path.join(libDir, file), "utf8");
    const exported = exportedNames(source);
    const imported = importedFrom(index, file);

    // Every imported name must exist in the module.
    for (const name of imported) {
      check(`${file} 导出 ${name}`, exported.has(name), `实际导出：${[...exported].join(", ")}`);
    }

    // Every exported name that index.js CALLS must be imported. A symbol used
    // but not imported is the ReferenceError landmine; a symbol imported but
    // unused is only untidiness, so only the first direction is fatal.
    for (const name of exported) {
      // Ignore a function's own definition site and any property access.
      const callPattern = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
      const usedInIndex = callPattern.test(index);
      if (!usedInIndex) continue;
      const ok = imported.has(name);
      check(
        `${file} 的 ${name} 已被导入`,
        ok,
        ok ? undefined : "index.js 使用了它但没有 import —— 调用时会 ReferenceError",
      );
    }
  }

  // The modules must load at all.
  for (const file of libFiles) {
    try {
      const mod = await import(pathToFileURL(path.join(libDir, file)).href);
      check(`${file} 可加载`, true, `${Object.keys(mod).length} exports`);
    } catch (error) {
      check(`${file} 可加载`, false, String(error?.message ?? error));
    }
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
