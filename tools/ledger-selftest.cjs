/**
 * Offline self-test for the query ledger, which backs both the Chat row and
 * `seen` de-duplication.
 *
 * NOTE ON THE DESIGN CONSTRAINT: this folds `tool/call` only. A custom event
 * type would break session reopening (an unknown stored type without
 * `ignorable: true` is refused, and `append()` cannot set that marker), so the
 * fold must ride on events the Session already writes.
 *
 * Usage: node tools/ledger-selftest.cjs
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "ledger.js")).href);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── normalization ───────────────────────────────────────────────────────
  check(
    "空白与全角空格归一",
    mod.normalizeQuery("Udon  同步变量") === mod.normalizeQuery("udon\u3000同步变量"),
  );
  check(
    "标点被忽略（仅差标点）",
    mod.normalizeQuery("Udon 同步变量，会怎样？") === mod.normalizeQuery("Udon 同步变量会怎样！"),
    mod.normalizeQuery("Udon 同步变量，会怎样？"),
  );
  check("标点删除后不残留空格", !mod.normalizeQuery("会怎样？").includes(" "));
  check("超长查询被截断", mod.normalizeQuery("x".repeat(500)).length <= 160);

  // ── fold: only tool/call counts ────────────────────────────────────────
  let state = mod.initLedger(700);
  const toolCall = (name, args, time) => ({
    type: "tool/call",
    seq: time,
    time,
    data: { turn: 1, step: 1, callId: `c${time}`, name, arguments: JSON.stringify(args) },
  });

  const afterDigest = mod.applyLedger(state, toolCall("vrchat_kb", { query: "Udon 同步变量" }, 1));
  check("digest 计数", afterDigest.digestCalls === 1, String(afterDigest.digestCalls));
  check("查询入账", afterDigest.queries.length === 1);
  check("保留原始 query 便于展示", afterDigest.queries[0].query === "Udon 同步变量");

  const afterSame = mod.applyLedger(afterDigest, toolCall("vrchat_kb", { query: "udon  同步变量！" }, 2));
  check("同义重复不新增条目", afterSame.queries.length === 1, String(afterSame.queries.length));
  check("但计数照常 +1（确实又调用了一次）", afterSame.digestCalls === 2);
  check("重复刷新 recency", afterSame.queries[0].at === 2);

  const afterOther = mod.applyLedger(afterSame, toolCall("vrchat_kb_grep", { pattern: "x" }, 3));
  check("grep 单独计数", afterOther.grepCalls === 1);
  const afterRead = mod.applyLedger(afterOther, toolCall("vrchat_kb_read", { file_path: "a.md" }, 4));
  const afterScan = mod.applyLedger(afterRead, toolCall("vrchat_kb_scan", { paths: ["a"] }, 5));
  check("read / scan 分别计数", afterScan.readCalls === 1 && afterScan.scanCalls === 1);

  // ── ignore non-tool-call events and untracked tools ────────────────────
  const irrelevant = mod.applyLedger(afterScan, { type: "assistant/message", seq: 6, time: 6, data: {} });
  check("非 tool/call 返回同一引用", irrelevant === afterScan);
  const untracked = mod.applyLedger(afterScan, toolCall("read", { file_path: "index.md" }, 7));
  check("无关工具返回同一引用", untracked === afterScan);

  // ── malformed arguments must not throw ─────────────────────────────────
  const broken = mod.applyLedger(afterScan, {
    type: "tool/call",
    seq: 8,
    time: 8,
    data: { turn: 1, step: 1, callId: "c8", name: "vrchat_kb", arguments: "{not json" },
  });
  check("坏 JSON 不抛错且仍计数", broken.digestCalls === afterScan.digestCalls + 1);

  // ── seen lookup ────────────────────────────────────────────────────────
  const prior = mod.findPriorQuery(afterSame, "UDON 同步变量？");
  check("seen 命中同义查询", prior !== undefined && prior.query === "Udon 同步变量");
  check("seen 不误判新查询", mod.findPriorQuery(afterSame, "poiyomi 变体") === undefined);
  check("seen 空查询不命中", mod.findPriorQuery(afterSame, "   ") === undefined);
  check("seen 无投影时安全返回 undefined", mod.findPriorQuery(undefined, "任何") === undefined);

  // ── view ───────────────────────────────────────────────────────────────
  const view = mod.ledgerView(afterScan);
  check("view 带注入块 token", view.blockTokens === 700);
  check("view 带最近查询", view.lastQuery === "Udon 同步变量", view.lastQuery);
  check("view 四项计数齐全", view.digestCalls === 2 && view.grepCalls === 1 && view.readCalls === 1 && view.scanCalls === 1);
  check("空账本 lastQuery 为 null", mod.ledgerView(mod.initLedger(0)).lastQuery === null);

  // ── cap ────────────────────────────────────────────────────────────────
  let many = mod.initLedger(0);
  for (let i = 0; i < 60; i++) many = mod.applyLedger(many, toolCall("vrchat_kb", { query: `q${i}` }, i));
  check("账本有上限", many.queries.length <= 40, String(many.queries.length));
  check("上限保留最新", many.queries.at(-1).query === "q59", many.queries.at(-1).query);

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
