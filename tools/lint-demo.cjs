/** End-to-end demo: scan one realistic bad VRChat script and print the report. */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SOURCE = [
  "using UnityEditor;",
  "using System.Collections.Generic;",
  "using UdonSharp;",
  "using UnityEngine;",
  "",
  "public class BadWorldScript : UdonSharpBehaviour",
  "{",
  "    // 注释里提到 List 与 async，不应触发",
  '    private string _note = "禁止 Dictionary 与 try-catch";',
  "",
  "    private List<int> _scores = new List<int>();",
  "",
  "    void Update()",
  "    {",
  "        var body = GetComponent<Rigidbody>();",
  "        if (!Networking.IsOwner(gameObject)) { _state = 1; }",
  "    }",
  "",
  "    async void Refresh() { await Something(); }",
  "}",
].join("\n");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "lint.js")).href);
  const filePath = "Assets/Scripts/BadWorldScript.cs";
  const findings = mod.rankFindings(mod.lintSource(filePath, SOURCE), "low");

  console.log(`规则 ${mod.ruleInventory().length} 条 | 命中 ${findings.length} 处`);
  console.log("");
  for (const f of findings) {
    console.log(`L${f.line} [${f.severity}] ${f.rule}`);
    console.log(`   ${f.evidence}`);
    console.log(`   依据：${f.because}`);
  }

  console.log("");
  console.log("--- 期望：注释/字符串里的违禁词不出现 ---");
  const inComment = findings.some((f) => f.line === 8 || f.line === 9);
  console.log(inComment ? "FAIL 注释行被误报" : "PASS 注释与字符串未误报");
  if (inComment) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
