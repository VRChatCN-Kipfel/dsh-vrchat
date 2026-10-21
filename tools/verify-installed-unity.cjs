/** Confirm the INSTALLED unity-status module is evidence-driven, not port-scanning. */
const fs = require("node:fs");
const path = require("node:path");
const generationsLib = require("./lib-generation.cjs");

const target = generationsLib.newestGeneration("dsh-vrchat-kb+");
const file = path.join(generationsLib.liveRoot(), target, "node_modules", "dsh-vrchat-kb", "lib", "unity-status.js");
const text = fs.readFileSync(file, "utf8");

// Strip comments so documentation about NOT scanning does not count as scanning.
const code = text
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
  .join("\n");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

console.log(`代: ${target}`);
console.log(`文件: ${text.length} 字符`);

check("含桥接模板表", /BRIDGE_TEMPLATES/.test(code));
check("含命令行证据识别", /detectCommandLineEvidence/.test(code));
check("含项目文件证据识别", /detectProjectEvidence/.test(code));
check("已无 judgePort", !/judgePort/.test(code));
check("已无端口扫描调用", !/NetTCPConnection|Get-NetTCP/i.test(code));
check("已无端口区间常量", !/20000\s*,\s*29999/.test(code));
check("报告会说明「找不到不等于没有」", /没有找到确凿的 MCP 证据/.test(text));
check("报告给出下一步动作", /Get-CimInstance Win32_Process/.test(text));
check("声明 token 不在本工具范围", /token 不在本工具范围内/.test(text));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
