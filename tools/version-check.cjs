/**
 * Verify that every Unity version mentioned in the injected prompt matches the
 * VRChat binding.
 *
 * WHY: VRChat pins a specific editor per SDK line (3.5.0+ → 2022.3.22f1,
 * 3.4.2 and older → 2019.4.31f1). Any other version produces a project that
 * cannot be uploaded. Upstream tool READMEs advertise their own eras — the
 * Unity-MCP CLI docs show `6000.3.1f1` — and copying one of those into the
 * persona would instruct the agent to scaffold a dead project.
 *
 * So this check does not look for "a version is mentioned". It rejects any
 * version that is NOT one of the two the library allows.
 *
 * Usage: node tools/version-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadFromHost } = require("./lib-host-require.cjs");
const requireFromProfile = loadFromHost;
const YAML = requireFromProfile("yaml");
const { workingPatch, locateRows } = require("./lib-patch-rows.cjs");

const ROOT = path.join(__dirname, "..");
const CORPUS = path.join(
  ROOT,
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// ── the authority: what the library actually binds ──────────────────────
const fact = fs.readFileSync(path.join(CORPUS, "FACT.md"), "utf8");
const bound = new Set();
for (const match of fact.matchAll(/Unity\s+(\d{4}\.\d+\.\d+f\d+)/g)) bound.add(match[1]);
check("从 FACT.md 读到绑定版本", bound.size >= 1, [...bound].join(", ") || "none");

// Every version the persona mentions must be one of them.
//
// `insert[0]` is NOT the preset — it is the always-on `vrchat-kb` row. That
// positional read threw a TypeError and took this whole check offline the moment
// the two-row patch shipped: a guard that cannot run is worse than no guard,
// because the suite still reports green for everything else.
const patch = workingPatch();
const persona = locateRows(patch).persona;
if (persona === undefined) {
  console.error("找不到 persona 行——补丁结构变了，本检查无法判断版本绑定");
  process.exit(1);
}
const texts = {
  prefix: persona?.config?.prefix ?? "",
  suffix: persona?.config?.suffix ?? "",
  t0: fs.readFileSync(path.join(ROOT, "data", "t0-core.txt"), "utf8"),
};

const VERSION = /\b(\d{4}\.\d+\.\d+f\d+)\b/g;

/**
 * Find versions used in a COMMAND position, ignoring ones cited as a warning.
 *
 * Mentioning a wrong version is sometimes the point — the persona cites
 * `6000.3.1f1` precisely to warn that following the CLI's generic example
 * produces an unuploadable project. Rejecting that mention would forbid the
 * warning. So the rule is: a version on a line that RUNS something
 * (`unity-mcp-cli ... --unity X`, `install-unity X`) must be a bound version;
 * a version inside a warning is allowed and separately asserted below.
 */
function commandVersions(text) {
  const offenders = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const isCommand = /unity-mcp-cli|install-unity|create-project|--unity/.test(line);
    if (!isCommand) continue;
    // A command line that also says "不能" / "不要" is still a command line —
    // the surrounding prose decides, and these lines are pure command samples.
    for (const match of line.matchAll(VERSION)) offenders.push({ line: index + 1, version: match[1] });
  }
  return offenders;
}

for (const [label, text] of Object.entries(texts)) {
  const offenders = commandVersions(text).filter((item) => !bound.has(item.version));
  check(
    `${label} 命令里的 Unity 版本都是绑定版本`,
    offenders.length === 0,
    offenders.length === 0
      ? "无命令或全部正确"
      : offenders.map((item) => `L${item.line} 用了 ${item.version}`).join("; "),
  );
}

// Every version mentioned ANYWHERE must be either bound or explicitly warned.
const allowed = new Set([...bound]);
const warningLine = /通用示例|不能|不要|错误|上传不了/;
const unvetted = [];
for (const [label, text] of Object.entries(texts)) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(VERSION)) {
      if (allowed.has(match[1])) continue;
      if (warningLine.test(lines[index])) continue; // cited as a warning, not used
      unvetted.push(`${label}:L${index + 1} ${match[1]}`);
    }
  }
}
check("非绑定版本只出现在警告语境", unvetted.length === 0, unvetted.join("; ") || "none");

// The specific regression: a Unity-6 sample must never reach a COMMAND line.
const all = `${texts.prefix}\n${texts.suffix}\n${texts.t0}`;
const commands = Object.values(texts).flatMap((text) => commandVersions(text));
check(
  "命令里没有 Unity 6 示例版本",
  !commands.some((item) => /^6000\./.test(item.version)),
  commands.map((item) => item.version).join(", ") || "none",
);
check("未出现 2021/2023 LTS 版本", !/\b(2021|2023)\.\d+\.\d+f\d+/.test(all));

// And the persona must actively state the constraint, not merely avoid a typo.
check("persona 写明 SDK 与版本绑定", /SDK 3\.5\.0\+\s*对应\s*\*\*2022\.3\.22f1\*\*/.test(texts.prefix), "应在 --unity 处写明绑定");
check("persona 警告别跟 CLI 通用示例走", /不能跟着 CLI 的通用示例走/.test(texts.prefix));
check("persona 说明用错版本的后果", /上传不了的工程/.test(texts.prefix));

// The 2019 line must be present too: older SDKs are a real, distinct binding.
check("persona 提到 2019.4.31f1", /2019\.4\.31f1/.test(texts.prefix));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
