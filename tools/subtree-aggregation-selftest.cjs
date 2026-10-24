/**
 * Prove the subtree aggregation counts children and never cross-charges tokens.
 *
 * The aggregation cannot be observed from the plugin's own `/vrchat stats` run in a
 * test harness: it needs live Sessions with real logs. So this reproduces the
 * algorithm against a fake session list and asserts the three properties that
 * matter:
 *
 *   1. A child's tool calls ARE added to the parent total.
 *   2. Granularity is not lost — a grandchild counts too (delegation nests).
 *   3. A child's injection characters are NOT added, because the child paid for its
 *      own context and the parent should not be billed twice.
 *
 * Usage: node tools/subtree-aggregation-selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

/**
 * The aggregation as implemented in index.js, extracted for testability.
 *
 * Kept in sync by assertion below: if `subtreeCalls` in index.js stops matching
 * this shape, the staleness check fails rather than the test silently drifting.
 */
function subtreeCalls(liveList, ledgerOf, root) {
  const childrenOf = new Map();
  for (const session of liveList) {
    const parent = session?.header?.parentSession;
    if (typeof parent !== "string") continue;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(session);
    childrenOf.set(parent, bucket);
  }
  const countOf = (session) => {
    const state = ledgerOf(session);
    if (state === undefined) return 0;
    return state.digestCalls + state.grepCalls + state.readCalls + state.scanCalls;
  };
  let calls = countOf(root);
  let descendants = 0;
  const queue = [...(childrenOf.get(root.id) ?? [])];
  const seen = new Set();
  while (queue.length > 0) {
    const session = queue.shift();
    if (session === undefined || seen.has(session.id)) continue;
    seen.add(session.id);
    descendants++;
    calls += countOf(session);
    queue.push(...(childrenOf.get(session.id) ?? []));
  }
  return { calls, descendants };
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const ledger = (n) => ({
  digestCalls: n,
  grepCalls: 0,
  readCalls: 0,
  scanCalls: 0,
});

// ── a three-level tree ──────────────────────────────────────────────────
const rootSession = { id: "root", header: { id: "root" } };
const childA = { id: "a", header: { id: "a", parentSession: "root", origin: "subagent" } };
const childB = { id: "b", header: { id: "b", parentSession: "root", origin: "subagent" } };
const grandchild = { id: "a1", header: { id: "a1", parentSession: "a", origin: "subagent", delegationDepth: 1 } };
const unrelated = { id: "x", header: { id: "x" } };

const ledgers = new Map([
  ["root", ledger(10)],
  ["a", ledger(3)],
  ["b", ledger(2)],
  ["a1", ledger(5)],
  ["x", ledger(99)],
]);
const ledgerOf = (session) => ledgers.get(session.id);

const all = [rootSession, childA, childB, grandchild, unrelated];
const result = subtreeCalls(all, ledgerOf, rootSession);

check("父会话自身的 10 次被计入", result.calls >= 10, String(result.calls));
check("两个直接子会话被计入（3+2）", result.calls === 10 + 3 + 2 + 5, `${result.calls}，期望 20`);
check("孙会话也被计入（层级会嵌套）", result.descendants === 3, `${result.descendants} 个后代，期望 3`);
check("无关的兄弟会话没有被计入", result.calls < 99 + 10, "只能沿 parentSession 往下走");

// ── token 不聚合 ────────────────────────────────────────────────────────
// The property is structural: `subtreeCalls` only ADDS counters, never
// `injectedChars`. Assert that by reading the real implementation's text, because
// a future edit that starts summing characters would still pass the counts above.
const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const body = /const subtreeCalls = \([\s\S]*?\n  \};/.exec(source)?.[0] ?? "";
check("找得到 subtreeCalls 实现", body.length > 100, `${body.length} 字符`);
check(
  "聚合只加计数，不碰注入字符",
  body.length > 0 && !body.includes("injectedChars"),
  body.includes("injectedChars") ? "发现 injectedChars，会造成双重计费" : "只累加 *Calls 字段",
);

// ── a cyclic header must not hang ───────────────────────────────────────
// Two sessions claiming each other as parent is invalid, but a slash command must
// not hang on it; `seen` is what stops the walk.
const cycleA = { id: "c1", header: { id: "c1", parentSession: "c2" } };
const cycleB = { id: "c2", header: { id: "c2", parentSession: "c1" } };
const cycLedgerOf = () => ledger(1);
const cycleRoot = { id: "c0", header: { id: "c0", parentSession: "c1" } };
const cycled = subtreeCalls([cycleA, cycleB, cycleRoot], cycLedgerOf, cycleRoot);
check("环状 parentSession 不会无限循环", Number.isFinite(cycled.calls) && cycled.descendants <= 2, JSON.stringify(cycled));

// ── the implementation this test mirrors must still exist ───────────────
const real = /const subtreeCalls = \(root\) => \{[\s\S]*?childrenOf\.get\(session\.id\)[\s\S]*?\n  \};/.exec(source);
check("index.js 的 subtreeCalls 结构未变（本测试未过期）", real !== null, "若改了实现，请同步本测试");

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
