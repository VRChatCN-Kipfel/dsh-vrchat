/**
 * Prove the data-completeness guard fires with an actionable message.
 *
 * The guard matters because a throw in `apply()` fails Harness STARTUP — so the
 * difference between `ENOENT: manifest.json` and an instruction telling the
 * reader to run the build is the difference between a mystery crash and a fix.
 *
 * Usage: node tools/guard-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "data");
const artifact = path.join(dataDir, "manifest.json");
const backup = `${artifact}.guard-check`;

const required = [
  "t0-core.txt",
  "always-load.txt",
  "domain-map.txt",
  "keyword-routes.json",
  "index.json",
  "manifest.json",
];

function assertDataPresent(dir) {
  const missing = required.filter((file) => !fs.existsSync(path.join(dir, file)));
  if (missing.length > 0) {
    throw new Error(
      `dsh-vrchat-kb: data/ 不完整，缺少 ${missing.join(", ")}。` +
        `data/ 是构建产物，请先运行：node tools/build-knowledge.mjs`,
    );
  }
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// Happy path: everything present.
try {
  assertDataPresent(dataDir);
  check("完整时通过", true);
} catch (error) {
  check("完整时通过", false, error.message);
}

// Missing-artifact path: rename one file away, expect the named message.
fs.renameSync(artifact, backup);
try {
  assertDataPresent(dataDir);
  check("缺失时抛错", false, "没有抛错");
} catch (error) {
  const message = String(error.message);
  check("缺失时抛错", true);
  check("消息点名缺失文件", message.includes("manifest.json"), message);
  check("消息给出修复命令", message.includes("node tools/build-knowledge.mjs"), message);
  check("消息不是裸 ENOENT", !/ENOENT/.test(message), message);
  console.log(`      抛出内容：${message}`);
} finally {
  fs.renameSync(backup, artifact);
}

check("被改名的文件已还原", fs.existsSync(artifact));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
