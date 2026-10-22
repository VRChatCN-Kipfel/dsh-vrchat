/**
 * Prove the tier↔injection contract check actually FAILS when broken.
 *
 * A guard that has never been observed failing is not evidence. The exact bug
 * this protects against already shipped once: `|| tier === "lite"` in
 * `injectSection`, which made the always-on row inject the red lines after all.
 *
 * The real index.js is never modified: a temp tree mirrors its layout.
 *
 * Usage: node tools/tier-contract-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const realIndex = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// Baseline: the untouched tree passes.
const baseline = spawnSync(process.execPath, [path.join(__dirname, "tools-deps-check.cjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
check("未改动时通过", baseline.status === 0, (baseline.stdout ?? "").trim().split("\n").at(-2));

/** Stage a broken copy in a temp tree that mirrors the real layout. */
function runBroken(name, mutated, expectPattern) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tier-contract-"));
  fs.mkdirSync(path.join(temp, "tools"), { recursive: true });
  fs.writeFileSync(path.join(temp, "index.js"), mutated, "utf8");
  fs.copyFileSync(path.join(ROOT, "cordis.patch.yml"), path.join(temp, "cordis.patch.yml"));
  fs.copyFileSync(path.join(__dirname, "tools-deps-check.cjs"), path.join(temp, "tools", "tools-deps-check.cjs"));

  const run = spawnSync(process.execPath, [path.join(temp, "tools", "tools-deps-check.cjs")], {
    cwd: temp,
    encoding: "utf8",
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  check(`${name} 时检查失败`, run.status !== 0, `exit=${run.status}`);
  check(`${name} 的报告点名问题`, expectPattern.test(output), output.split("\n").find((l) => l.startsWith("FAIL")) ?? "");
  fs.rmSync(temp, { recursive: true, force: true });
}

// ── break 1: the exact historical bug ─────────────────────────────────────
runBroken(
  "把 lite 加回注入条件",
  realIndex.replace(
    'const injectSection = tier === "preset" || tier === "full";',
    'const injectSection = tier === "preset" || tier === "full" || tier === "lite";',
  ),
  /lite 必须不注入|injectSection 只认/,
);

// ── break 2: default drifts to an injecting tier ──────────────────────────
runBroken(
  "缺省 tier 改成 preset",
  realIndex.replace('typeof config?.tier === "string" ? config.tier : "tools-only"', 'typeof config?.tier === "string" ? config.tier : "preset"'),
  /缺省 tier 是 tools-only/,
);

// ── break 3: the duplication returns ──────────────────────────────────────
//
// The section was reduced to a short status note precisely because it used to
// re-emit the blocks the suffix already carries. Re-introducing the inline copy
// is the regression that matters now, so prove the check catches it.
runBroken(
  "把注入块内联回 section",
  realIndex.replace(
    'const sectionText = [',
    'const baseText = `${data.t0}\\n\\n---\\n\\n${data.alwaysLoad}`;\n  const sectionText = [ baseText,',
  ),
  /section 不再按 blockKey 复制注入块|section 不内联 t0 或 always-load/,
);

// The real tree must be intact.
check("真实 index.js 未被修改", fs.readFileSync(path.join(ROOT, "index.js"), "utf8") === realIndex);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
