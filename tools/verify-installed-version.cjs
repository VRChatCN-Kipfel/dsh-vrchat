/** Confirm the INSTALLED generation carries the corrected Unity version. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const generationsLib = require("./lib-generation.cjs");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");

const target = generationsLib.newestGeneration("dsh-vrchat-kb+");
const pkgRoot = path.join(generationsLib.liveRoot(), target, "node_modules", "dsh-vrchat-kb");
const patch = YAML.parse(fs.readFileSync(path.join(pkgRoot, "cordis.patch.yml"), "utf8"));
const prefix = patch[0].insert[0].config.plugins.find((plugin) => plugin.id === "persona").config.prefix;

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

console.log(`代: ${target}`);

// Command lines must only carry the bound version.
const commandLines = prefix.split("\n").filter((line) => /unity-mcp-cli|--unity/.test(line));
const versionsInCommands = commandLines.flatMap((line) => [...line.matchAll(/\b(\d{4}\.\d+\.\d+f\d+)\b/g)].map((m) => m[1]));

check("命令里出现版本号", versionsInCommands.length > 0, versionsInCommands.join(", "));
check(
  "命令里全部是 2022.3.22f1",
  versionsInCommands.length > 0 && versionsInCommands.every((v) => v === "2022.3.22f1"),
  versionsInCommands.join(", "),
);
check("命令里没有 6000.x", !versionsInCommands.some((v) => v.startsWith("6000.")));
check("写明 SDK 绑定", /SDK 3\.5\.0\+\s*对应\s*\*\*2022\.3\.22f1\*\*/.test(prefix));
check("警告别跟 CLI 通用示例", /不能跟着 CLI 的通用示例走/.test(prefix));
check("说明后果是上传不了", /上传不了的工程/.test(prefix));
check("提到旧版绑定 2019.4.31f1", /2019\.4\.31f1/.test(prefix));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
