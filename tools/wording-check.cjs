/**
 * Guard the user-facing wording about where the corpus lives.
 *
 * The corpus ships INSIDE the package. Twice now the code told the user the
 * opposite — that their WORKSPACE lacked a submodule checkout — which sends them
 * to fix the wrong thing (their project) instead of the right one (this install).
 * That is a user-visible misdiagnosis, not a comment nit, so it gets a gate.
 *
 * Also checks the adjacent trap: a runtime failure returning `undefined` values,
 * because `dsh-tools` then reports INVALID_TOOL_OUTPUT and the careful message
 * never reaches the model.
 *
 * Usage: node tools/wording-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const shipped = [
  "index.js",
  ...fs.readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`),
];

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

/**
 * Files split into "user-facing text" and "everything else".
 * A string literal or a `//`/`*` comment counts as text; code does not.
 */
function scanForBannedWording(rel) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const lines = text.split("\n");
  const hits = [];

  // Phrases that assert the WRONG location. Deliberately narrow: the correct
  // wording also mentions "工作区" ("与你的工作区无关") and must not trip this.
  const banned = [
    /当前工作区没找到/,
    /工作区(里|中)?没(有)?找到.*(检出|submodule)/i,
    /missing from this workspace/i,
    /workspace lacks the checkout/i,
    /corpus checkout is missing from/i,
    /请确认.*submodule update --init.*工作区/,
  ];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Only prose: a string literal or a comment. Bare identifiers in code cannot
    // mislead a user, and flagging them would make this gate noise.
    const isProse = /["'`]/.test(line) || /^\s*(\/\/|\*)/.test(line);
    if (!isProse) continue;
    // A line that NEGATES the bad phrasing is documentation of the rule, not a
    // violation of it ("never 'your workspace lacks the checkout'").
    if (/\b(never|not|avoid|don't|不要|而非|而不是)\b/i.test(line)) continue;
    for (const pattern of banned) {
      if (pattern.test(line)) {
        hits.push(`${rel}:${index + 1} ${line.trim().slice(0, 100)}`);
        break;
      }
    }
  }
  return hits;
}

const wordingHits = shipped.flatMap(scanForBannedWording);
check(
  "不把语料缺失误诊为用户工作区问题",
  wordingHits.length === 0,
  wordingHits.slice(0, 3).join(" | ") || "none",
);

// The correct wording must actually be present, or the check above passes
// vacuously on files that say nothing at all.
const indexText = fs.readFileSync(path.join(root, "index.js"), "utf8");
check(
  "语料缺失文案指明是本安装缺少自带语料",
  /本插件的安装里缺少自带的语料目录/.test(indexText),
);
check("说明语料与工作区无关", /与你在哪个工作区无关/.test(indexText));

// ── no undefined-valued returns on a tool failure path ───────────────────
for (const rel of shipped) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const offenders = [];
  for (const [index, line] of text.split("\n").entries()) {
    // `key: undefined` or a bare `undefined` used as a value in a returned object.
    if (/\b\w+:\s*undefined\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
      offenders.push(`${rel}:${index + 1} ${line.trim().slice(0, 80)}`);
    }
  }
  check(`${rel} 无 key: undefined 返回值`, offenders.length === 0, offenders.slice(0, 2).join(" | ") || "none");
}

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
