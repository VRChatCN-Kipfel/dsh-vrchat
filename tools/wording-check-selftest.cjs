/**
 * Prove wording-check.cjs actually fails on the wording it forbids.
 *
 * A guard nobody has watched fail is not evidence. This stages broken copies in a
 * temp tree that mirrors the real layout and asserts the check reports them.
 *
 * Usage: node tools/wording-check-selftest.cjs
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
const baseline = spawnSync(process.execPath, [path.join(__dirname, "wording-check.cjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
check("未改动时通过", baseline.status === 0, (baseline.stdout ?? "").trim().split("\n").at(-2));

/** Mirror the layout in a temp dir and run the check against a mutated index.js. */
function runBroken(name, mutated, expectPattern) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wording-check-"));
  fs.mkdirSync(path.join(temp, "tools"), { recursive: true });
  fs.mkdirSync(path.join(temp, "lib"), { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, "lib"))) {
    fs.copyFileSync(path.join(ROOT, "lib", file), path.join(temp, "lib", file));
  }
  fs.writeFileSync(path.join(temp, "index.js"), mutated, "utf8");
  fs.copyFileSync(path.join(__dirname, "wording-check.cjs"), path.join(temp, "tools", "wording-check.cjs"));

  const run = spawnSync(process.execPath, [path.join(temp, "tools", "wording-check.cjs")], {
    cwd: temp,
    encoding: "utf8",
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  check(`${name} 时检查失败`, run.status !== 0, `exit=${run.status}`);
  check(
    `${name} 的报告点名问题`,
    expectPattern.test(output),
    output.split("\n").find((line) => line.startsWith("FAIL")) ?? "",
  );
  fs.rmSync(temp, { recursive: true, force: true });
}

// ── break 1: the exact historical misdiagnosis ───────────────────────────
runBroken(
  "语料缺失文案改回「工作区没找到检出」",
  realIndex.replace(
    '"知识库语料不可用：**本插件的安装里缺少自带的语料目录**（`VRChat-Agent-Creator-Library/`）。\\n" +',
    '"知识库语料不可用：当前工作区没找到 `VRChat-Agent-Creator-Library/` 检出。\\n" +',
  ),
  /不把语料缺失误诊为用户工作区问题/,
);

// ── break 2: a tool returns undefined again ─────────────────────────────
//
// Target the corpus-missing branch. The mutation must be asserted to APPLY, not
// just attempted: a stale replace that matches nothing silently makes the test
// pass for the wrong reason.
const brokenUndefined = realIndex.replace(
  "            path: null,\n            // Echo the caller's offset only when one was given",
  "            path: undefined,\n            // Echo the caller's offset only when one was given",
);
check("构造了 undefined 破坏（替换确实生效）", brokenUndefined !== realIndex);
runBroken("read 的失败分支又返回 undefined", brokenUndefined, /无 key: undefined 返回值/);

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
