/**
 * Drive the real `/vrchat` command handler and assert what it prints.
 *
 * WHY THIS EXISTS: `validate-schemas.mjs` runs `apply()` with a stub context whose
 * `get()` returns `undefined` for every service. That means `commands` is never
 * available there, so the `/vrchat` handler has NEVER been executed by any check —
 * including the `stats` output a human reads and trusts. A crash inside it, or a
 * figure that contradicts reality, is invisible to the whole suite.
 *
 * Loads index.js through the same source-stub trick, because it imports Harness
 * packages that only resolve inside a profile.
 *
 * Usage: node tools/probe-command.cjs [lite|preset]
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

/**
 * Build a stub context that actually HAS the optional services.
 *
 * Unlike the schema validator's stub, this one hands back registries: the point is
 * to run handlers, so `get()` must answer for `commands`, `tokenMeter` and
 * `sessionProjections`.
 */
function makeContext(captured) {
  const registries = { sections: [], commands: [], tools: [], projections: [] };
  return {
    registries,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    systemPrompt: { section: (def) => (registries.sections.push(def), () => {}) },
    tools: { register: (def) => (captured.push(def), () => {}) },
    // Do NOT swallow: a throw inside apply() is exactly what this probe is for.
    effect: (fn) => {
      fn();
      return () => {};
    },
    get: (name) => {
      if (name === "commands") return { register: (def) => (registries.commands.push(def), () => {}) };
      if (name === "sessionProjections") {
        return {
          register: (def) => {
            registries.projections.push(def);
            return () => {};
          },
          stateOf: () => undefined,
        };
      }
      if (name === "tokenMeter") {
        return {
          // The router's real behaviour: a flat chars/4 that never sees language.
          estimateMessage: ({ content }) => Math.ceil(content[0].text.length / 4) + 4,
          measure: () => ({
            totalTokens: 12345,
            baseline: { kind: "system-prompt", tokens: 4000 },
            surfaceTokens: 8345,
          }),
        };
      }
      return undefined;
    },
  };
}

/** Load index.js with Harness-only imports replaced by stubs. */
async function loadStubbed() {
  const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const noop = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "default") return () => noop;
        return () => noop;
      },
    },
  );
  const patched = source
    .replace(/import z from "@deepseek-ai\/schemastery";/, "const z = globalThis.__z;")
    .replace(/import \{ z as zod \} from "zod";/, "const zod = globalThis.__z;")
    .replace(/import \{ defineTool \} from "@deepseek-ai\/dsh-tools";/, "const defineTool = (d) => d;");
  globalThis.__z = noop;
  const tmp = path.join(ROOT, ".probe-command.mjs");
  fs.writeFileSync(tmp, patched, "utf8");
  // NOT cleaned up here: `fs.rmSync` crashes Node 24.9.0 on Windows with
  // 0xC0000409 (a __fastfail that bypasses every JS handler). The file is
  // gitignored via `.index-check.mjs`-style convention and rewritten each run.
  return await import(`${pathToFileURL(tmp).href}?v=${Date.now()}`);
}

async function main() {
  const tier = process.argv[2] ?? "preset";
  const mod = await loadStubbed();
  const captured = [];
  const ctx = makeContext(captured);
  mod.apply(ctx, { tier });

  const stats = ctx.registries.commands.find((command) => command.name === "vrchat");
  if (stats === undefined) {
    console.log(`tier=${tier} → 没有注册 /vrchat 命令`);
    process.exitCode = 1;
    return;
  }

  // Run with no agent: `readLedger` must degrade rather than throw, because a slash
  // command can execute outside a tool invocation.
  const result = stats.handler({ rawInput: "stats", agent: undefined });
  console.log(`=== tier=${tier} / /vrchat stats ===`);
  console.log(result.text);
  console.log("");

  // The projection seed is what the dock renders from — check both roles.
  for (const projection of ctx.registries.projections) {
    const root = projection.init({ origin: undefined, parentSession: undefined });
    const child = projection.init({ origin: "subagent", parentSession: "s1" });
    console.log(`projection.init(根)  injectedChars=${root.injectedChars} role=${root.role}`);
    console.log(`projection.init(子)  injectedChars=${child.injectedChars} role=${child.role} parent=${child.parentSession}`);
    console.log(`view(根)             ${JSON.stringify(projection.wire.view(root))}`);
    console.log(`view(子)             ${JSON.stringify(projection.wire.view(child))}`);
  }
}

main().catch((error) => {
  console.error("PROBE FAILED:", error?.stack ?? error);
  process.exit(1);
});
