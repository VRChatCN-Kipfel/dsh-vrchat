/**
 * End-to-end check: does the REAL `vrchat_kb` handler stop claiming "already asked"
 * on a first query?
 *
 * This is the check that was missing. `ledger-selftest.cjs` exercises
 * `findPriorQuery` in isolation, and it asserted the BUG as correct behaviour
 * ("首查就命中") because it never modelled the ordering that causes it: the
 * `tool/call` event is folded into the ledger BEFORE the handler runs. Only a
 * driver that reproduces that order can catch it.
 *
 * Usage: node tools/probe-digest-repeat.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const { createRequire } = require("node:module");
const { findHostModules } = require("./lib-host-modules.cjs");
const requireHost = createRequire(path.join(findHostModules(), "noop.js"));

/** Minimal ctx: tools registry + a projections service backed by one mutable state. */
function makeContext() {
  const tools = [];
  let ledgerState = null;
  const projections = {
    register: () => () => {},
    stateOf: () => ledgerState,
  };
  return {
    tools,
    projections,
    setLedger: (s) => {
      ledgerState = s;
    },
    ctx: {
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      systemPrompt: { section: () => () => {} },
      tools: { register: (def) => (tools.push(def), () => {}) },
      effect: (fn) => {
        fn();
        return () => {};
      },
      get: (name) => {
        if (name === "sessionProjections") return projections;
        return undefined;
      },
    },
  };
}

async function loadStubbed() {
  const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const noop = new Proxy(
    {},
    {
      get: (_t, key) => (key === "default" ? () => noop : () => noop),
    },
  );
  const patched = source
    .replace(/import z from "@deepseek-ai\/schemastery";/, "const z = globalThis.__z;")
    .replace(/import \{ z as zod \} from "zod";/, "const zod = globalThis.__z;")
    .replace(/import \{ defineTool \} from "@deepseek-ai\/dsh-tools";/, "const defineTool = (d) => d;");
  globalThis.__z = noop;
  const tmp = path.join(ROOT, ".probe-digest-repeat.mjs");
  fs.writeFileSync(tmp, patched, "utf8");
  return await import(`${pathToFileURL(tmp).href}?v=${Date.now()}`);
}

async function main() {
  const ledger = await import(pathToFileURL(path.join(ROOT, "lib", "ledger.js")).href);
  const mod = await loadStubbed();
  const harness = makeContext();
  mod.apply(harness.ctx, { tier: "preset" });

  const digest = harness.tools.find((tool) => tool.name === "vrchat_kb");
  if (digest === undefined) {
    console.error("FAIL: 没有注册 vrchat_kb 工具");
    process.exit(1);
  }

  const Q = "Blender 里改了形态键，Unity 里不显示";
  const exec = { agent: { session: { header: { origin: undefined } } }, signal: undefined };

  let state = ledger.initLedger({ injectedChars: 100, role: "root", parentSession: null });
  state = ledger.applyLedger(state, { type: "turn/start", time: 1, data: { turn: 1 } });

  // --- call #1: fold the event FIRST (that is the real order), then run the handler.
  state = ledger.applyLedger(state, {
    type: "tool/call",
    time: 2,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: Q }) },
  });
  harness.setLedger(state);
  const first = await digest.execute({ query: Q }, exec);
  const firstClaimsRepeat = first.text.includes("本轮已查过等价问题");

  // --- call #2: same query again in the same turn → this one SHOULD say it.
  state = ledger.applyLedger(state, {
    type: "tool/call",
    time: 3,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: Q }) },
  });
  harness.setLedger(state);
  const second = await digest.execute({ query: Q }, exec);
  const secondClaimsRepeat = second.text.includes("本轮已查过等价问题");

  // --- call #3: a different query must never claim a repeat.
  state = ledger.applyLedger(state, {
    type: "tool/call",
    time: 4,
    data: { name: "vrchat_kb", arguments: JSON.stringify({ query: "Udon 同步变量" }) },
  });
  harness.setLedger(state);
  const third = await digest.execute({ query: "Udon 同步变量" }, exec);
  const thirdClaimsRepeat = third.text.includes("本轮已查过等价问题");

  const checks = [
    ["首查不声称「已查过」", firstClaimsRepeat === false],
    ["同轮第二次同问题才声称「已查过」", secondClaimsRepeat === true],
    ["不同问题从不相称", thirdClaimsRepeat === false],
    ["首查仍然命中结果", first.hit === true && first.pageCount > 0],
    ["第二次仍给内容（不是只给提示）", second.hit === true && second.text.length > 200],
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) {
    console.log("\n--- 首查响应前 200 字符 ---");
    console.log(first.text.slice(0, 200));
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("PROBE FAILED:", error?.stack ?? error);
  process.exit(1);
});
