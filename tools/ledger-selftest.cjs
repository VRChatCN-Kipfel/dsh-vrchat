/**
 * Offline self-test for the turn-scoped query ledger.
 *
 * The two rules under test are the ones a naive implementation gets wrong:
 *   1. "already asked" is scoped to the TURN (not the session, not the step);
 *   2. compaction INVALIDATES it, because the earlier digest was replaced out
 *      of the visible conversation.
 *
 * Usage: node tools/ledger-selftest.cjs
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "ledger.js")).href);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // Builders for the three logged event types the fold understands.
  const ev = (type, data, time) => ({ type, seq: time, time, data });
  const turnStart = (turn, time) => ev("turn/start", { turn }, time);
  const compaction = (time) => ev("compaction/start", { compactionId: `c${time}`, turn: 1 }, time);
  const toolCall = (name, args, time) =>
    ev("tool/call", { turn: 1, step: 1, callId: `c${time}`, name, arguments: JSON.stringify(args) }, time);

  // ── normalization ───────────────────────────────────────────────────────
  check("空白与全角归一", mod.normalizeQuery("Udon  同步变量") === mod.normalizeQuery("udon\u3000同步变量"));
  check(
    "标点被忽略",
    mod.normalizeQuery("Udon 同步变量，会怎样？") === mod.normalizeQuery("Udon 同步变量会怎样！"),
  );
  check("超长查询被截断", mod.normalizeQuery("x".repeat(500)).length <= 160);

  // ── rule 1: same turn → remembered ──────────────────────────────────────
  let state = mod.initLedger(700);
  state = mod.applyLedger(state, turnStart(1, 1));
  state = mod.applyLedger(state, toolCall("vrchat_kb", { query: "Udon 同步变量" }, 2));

  check("turn 已记录", state.turn === 1, String(state.turn));
  check("首查入账", state.queries.length === 1);
  check("首查计数", state.digestCalls === 1);

  const sameTurn = mod.findPriorQuery(state, "udon 同步变量！");
  check("同轮同问题命中（应提示已查）", sameTurn !== undefined, sameTurn?.query);

  // Another step in the SAME turn must still hit: steps are not the scope.
  const nextStep = mod.applyLedger(state, toolCall("vrchat_kb", { query: "physbone 上限" }, 3));
  check(
    "同轮跨步仍命中",
    mod.findPriorQuery(nextStep, "Udon 同步变量") !== undefined,
    "step 不改变作用域",
  );

  // ── rule 1b: next turn → forgotten ──────────────────────────────────────
  const turn2 = mod.applyLedger(nextStep, turnStart(2, 4));
  check("进入第 2 轮", turn2.turn === 2);
  check(
    "跨轮不再提示已查（必须重新给结果）",
    mod.findPriorQuery(turn2, "Udon 同步变量") === undefined,
  );

  // ── rule 2: compaction invalidates ──────────────────────────────────────
  let s2 = mod.initLedger(700);
  s2 = mod.applyLedger(s2, turnStart(1, 1));
  s2 = mod.applyLedger(s2, toolCall("vrchat_kb", { query: "Udon 同步变量" }, 2));
  check("压缩前命中", mod.findPriorQuery(s2, "Udon 同步变量") !== undefined);

  const afterCompaction = mod.applyLedger(s2, compaction(3));
  check("压缩递增 generation", afterCompaction.generation === 1, String(afterCompaction.generation));
  check("压缩清空已查记录", afterCompaction.queries.length === 0);
  check(
    "压缩后不再提示已查（结果已从上下文消失）",
    mod.findPriorQuery(afterCompaction, "Udon 同步变量") === undefined,
  );
  check("压缩不影响累计调用数", afterCompaction.digestCalls === 1);

  // A query AFTER compaction is remembered again.
  const afterCompactionQuery = mod.applyLedger(
    afterCompaction,
    toolCall("vrchat_kb", { query: "Udon 同步变量" }, 4),
  );
  check(
    "压缩后重新查询可再次入账",
    mod.findPriorQuery(afterCompactionQuery, "Udon 同步变量") !== undefined,
  );
  check("且 generation 为新的一代", afterCompactionQuery.queries[0].generation === 1);

  // Turning the page also invalidates the earlier generation's records.
  const turn3 = mod.applyLedger(afterCompactionQuery, turnStart(2, 5));
  check(
    "跨轮 + 跨压缩后仍不命中",
    mod.findPriorQuery(turn3, "Udon 同步变量") === undefined,
  );

  // ── counters ────────────────────────────────────────────────────────────
  let counted = mod.initLedger(0);
  counted = mod.applyLedger(counted, turnStart(1, 1));
  counted = mod.applyLedger(counted, toolCall("vrchat_kb", { query: "a" }, 2));
  counted = mod.applyLedger(counted, toolCall("vrchat_kb_grep", { pattern: "x" }, 3));
  counted = mod.applyLedger(counted, toolCall("vrchat_kb_read", { file_path: "a.md" }, 4));
  counted = mod.applyLedger(counted, toolCall("vrchat_kb_scan", { paths: ["a"] }, 5));
  check(
    "四项计数独立",
    counted.digestCalls === 1 && counted.grepCalls === 1 && counted.readCalls === 1 && counted.scanCalls === 1,
  );

  // ── purity: irrelevant events must not allocate ─────────────────────────
  const irrelevant = mod.applyLedger(counted, ev("assistant/message", {}, 6));
  check("无关事件返回同一引用", irrelevant === counted);
  const untracked = mod.applyLedger(counted, toolCall("read", { file_path: "x.md" }, 7));
  check("无关工具返回同一引用", untracked === counted);

  // ── malformed arguments ────────────────────────────────────────────────
  const broken = mod.applyLedger(counted, {
    type: "tool/call",
    seq: 8,
    time: 8,
    data: { turn: 1, step: 1, callId: "c8", name: "vrchat_kb", arguments: "{not json" },
  });
  check("坏 JSON 不抛错且仍计数", broken.digestCalls === counted.digestCalls + 1);

  // ── view ───────────────────────────────────────────────────────────────
  const view = mod.ledgerView(counted);
  check("view 带注入块 token", view.blockTokens === 0);
  check("view 带轮次", view.turn === 1);
  check("view 带最近查询", view.lastQuery === "a", view.lastQuery);
  check("空账本 lastQuery 为 null", mod.ledgerView(mod.initLedger(0)).lastQuery === null);

  // ── cap ────────────────────────────────────────────────────────────────
  let many = mod.initLedger(0);
  many = mod.applyLedger(many, turnStart(1, 0));
  for (let i = 0; i < 60; i++) many = mod.applyLedger(many, toolCall("vrchat_kb", { query: `q${i}` }, i + 1));
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
