/**
 * Prove that imports-check.cjs actually FAILS when an import is missing.
 *
 * A guard that has never been observed failing is not evidence of anything, so
 * this deliberately removes one import from a COPY of index.js, runs the check
 * against that copy, and asserts the check reports a failure. The real file is
 * never touched.
 *
 * Usage: node tools/imports-check-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const realIndex = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// Run the real check first: it must pass on the untouched tree.
const passRun = spawnSync(process.execPath, [path.join(__dirname, "imports-check.cjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
check("未改动时检查通过", passRun.status === 0, (passRun.stdout ?? "").trim().split("\n").at(-2));

// Now break a copy: drop the ledger import, which is exactly the bug that got
// through `node --check` and `validate-schemas`.
const broken = realIndex.replace(
  /import \{\s*\n\s*initLedger,\s*\n\s*applyLedger,\s*\n\s*ledgerView,\s*\n\s*findPriorQuery,\s*\n\} from "\.\/lib\/ledger\.js";\n/,
  "",
);
check("测试构造成功（import 已被移除）", broken !== realIndex && !broken.includes('from "./lib/ledger.js"'));

// Stage the broken copy in a temp tree that MIRRORS the real layout:
// `<temp>/index.js` + `<temp>/lib/` + `<temp>/tools/imports-check.cjs`. The
// script resolves its root as `__dirname/..`, so dropping it at the temp root
// would make it look one level too high and check nothing.
// `fs.cpSync(..., { recursive: true })` crashes this Node build on Windows
// (0xC0000409, stack buffer overrun), so the few files are copied by hand.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "imports-check-"));
fs.mkdirSync(path.join(temp, "lib"), { recursive: true });
fs.mkdirSync(path.join(temp, "tools"), { recursive: true });
for (const file of fs.readdirSync(path.join(ROOT, "lib"))) {
  fs.copyFileSync(path.join(ROOT, "lib", file), path.join(temp, "lib", file));
}
fs.writeFileSync(path.join(temp, "index.js"), broken, "utf8");
fs.copyFileSync(path.join(__dirname, "imports-check.cjs"), path.join(temp, "tools", "imports-check.cjs"));
const brokenRun = spawnSync(process.execPath, [path.join(temp, "tools", "imports-check.cjs")], {
  cwd: temp,
  encoding: "utf8",
});
const brokenOutput = `${brokenRun.stdout ?? ""}${brokenRun.stderr ?? ""}`;

check("缺 import 时检查失败", brokenRun.status !== 0, `exit=${brokenRun.status}`);
check(
  "失败信息点名了具体符号",
  /initLedger|applyLedger|ledgerView|findPriorQuery/.test(brokenOutput),
  brokenOutput.split("\n").filter((line) => line.startsWith("FAIL")).slice(0, 3).join(" / "),
);
check(
  "失败信息说明了原因",
  /ReferenceError/.test(brokenOutput),
  brokenOutput.split("\n").find((line) => line.includes("ReferenceError")) ?? "",
);

fs.rmSync(temp, { recursive: true, force: true });

// The real tree must still be intact.
check("真实 index.js 未被修改", fs.readFileSync(path.join(ROOT, "index.js"), "utf8") === realIndex);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
