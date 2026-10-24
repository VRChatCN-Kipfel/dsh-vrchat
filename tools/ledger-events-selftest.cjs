/**
 * Ledger defects caught by a real-session review, asserted here so they cannot
 * regress. Both were invisible to the existing 38-check suite because that suite
 * only modelled serial happy paths with `turn/start` and `compaction/start`.
 *
 * Usage: node tools/ledger-events-selftest.cjs
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "ledger.js")).href);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── 1. `compaction/prune` destroys visible content and must invalidate the hint ──
  //
  // The host's tool-result pruner rewrites the middle of a long digest and appends
  // `compaction/prune` alone — no `compaction/start`. The ledger ignored that event,
  // so a later "结果就在上文" pointed at a result whose middle had been cut away.
  let st = mod.initLedger({ injectedChars: 100, role: "root", parentSession: null });
  st = mod.applyLedger(st, { type: "turn/start", time: 1, data: { turn: 1 } });
  st = mod.applyLedger(st, {
    type: "tool/call",
    time: 2,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: "Udon 同步变量" }) },
  });
  check("prune 前 generation=0", st.generation === 0, String(st.generation));

  // A second identical call so the repeat notice is armed before the prune.
  st = mod.applyLedger(st, {
    type: "tool/call",
    time: 3,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: "Udon 同步变量" }) },
  });
  check("prune 前已可提示重复", mod.findPriorQuery(st, "Udon 同步变量", { excludeCurrentCall: true }) !== undefined);

  const pruned = mod.applyLedger(st, { type: "compaction/prune", time: 4, data: { pruned: true } });
  check("prune 使 generation 递增", pruned.generation === 1, String(pruned.generation));
  check("prune 后不再提示重复", mod.findPriorQuery(pruned, "Udon 同步变量", { excludeCurrentCall: true }) === undefined);
  // The fact that the query ran stays true; only the claim about its visibility dies.
  check("prune 保留 queries 条目", pruned.queries.length === 1, String(pruned.queries.length));

  // ── 2. `calls` must survive serialization, or the notice silently stops ─────────
  //
  // zod v4 strips unknown keys. `ledgerEntrySchema` did not list `calls`, so a
  // checkpoint restore dropped it and `(entry.calls ?? 1) >= 2` never fired again.
  // Asserted at the JSON layer here; the schema itself is checked by the tool that
  // loads index.js.
  //
  // NOTE the baseline: `st` has already recorded this query twice (time 2 and 3), so
  // the next call makes it 3 — not 2. Getting this wrong is what a review is for.
  const before = st.queries[0].calls;
  const onceMore = mod.applyLedger(st, {
    type: "tool/call",
    time: 5,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: "Udon 同步变量" }) },
  });
  check("再次调用使 calls 递增", onceMore.queries[0].calls === before + 1, `${before} -> ${onceMore.queries[0].calls}`);

  const roundTripped = JSON.parse(JSON.stringify(onceMore));
  check(
    "JSON 往返保留 calls",
    roundTripped.queries[0].calls === before + 1,
    String(roundTripped.queries[0].calls),
  );

  const restored = mod.applyLedger(roundTripped, {
    type: "tool/call",
    time: 6,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: "Udon 同步变量" }) },
  });
  check("恢复后的账本仍能累加 calls", restored.queries[0].calls === before + 2, String(restored.queries[0].calls));

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("SELFTEST FAILED:", error?.stack ?? error);
  process.exit(1);
});
