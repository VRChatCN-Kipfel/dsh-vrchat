/**
 * Offline schema validation for the plugin's tool definitions.
 *
 * WHY THIS EXISTS: the tool-definition schema DSL is much stricter than JSON
 * Schema, and every violation is thrown from `defineTool` at plugin activation.
 * That activation happens during Harness STARTUP, and this bundle's row is
 * `required`, so a single schema mistake takes the whole app down — which is
 * exactly what happened once. `node --check` cannot see this class of error.
 *
 * This runs the SHIPPED compiler over every tool the plugin would register, so
 * the mistake surfaces here instead of at boot.
 *
 * Usage: node tools/validate-schemas.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const COMPILER_PATH =
  "D:/Program Files/DSH Desktop/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-tools/lib/index.js";

const require = createRequire(import.meta.url);

/** The shipped compiler plus the DSL's value-schema entry point. */
async function loadTools() {
  return import(new URL(`file:///${COMPILER_PATH.replace(/ /g, "%20")}`).href);
}

/**
 * Validate one tool definition's `output.schema` and `parameters` the way
 * `defineTool` does, without registering anything.
 */
function validateTool(mod, definition) {
  const problems = [];

  // `parameters` uses the ParameterSchemaSpec path; `output.schema` uses the
  // value-schema DSL. Both are compiled by `defineTool`, so exercising both is
  // the point.
  try {
    mod.defineTool({
      ...definition,
      // Never called: defineTool compiles at definition time.
      async execute() {
        return null;
      },
    });
  } catch (error) {
    problems.push(String(error?.message ?? error));
  }

  return problems;
}

async function main() {
  const mod = await loadTools();

  // Extract the four tool definitions from index.js without importing it (it
  // imports Harness packages that only resolve inside the profile).
  const source = readFileSync(join(root, "index.js"), "utf8");
  const names = [...source.matchAll(/defineTool\(\{\s*\n\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log(`index.js 声明了 ${names.length} 个工具：${names.join(", ")}`);
  console.log("");

  // Instead of re-parsing the source, load the real module with a minimal stub
  // context: registering into a fake registry captures each definition verbatim.
  const stubbed = await importWithStubs();
  const captured = [];
  const ctx = makeStubContext(captured);

  let applied = false;
  try {
    stubbed.apply(ctx, { tier: "lite", charBudget: 3200, maxPages: 4 });
    applied = true;
  } catch (error) {
    console.log(`apply() 抛出：${String(error?.message ?? error)}`);
  }
  console.log(`apply() ${applied ? "执行完成" : "失败"}；捕获 ${captured.length} 个工具定义`);
  console.log("");

  let failed = 0;
  for (const definition of captured) {
    const problems = validateTool(mod, definition);
    if (problems.length === 0) {
      console.log(`PASS  ${definition.name}`);
      continue;
    }
    failed++;
    console.log(`FAIL  ${definition.name}`);
    for (const problem of problems) console.log(`      ${problem}`);
  }

  console.log("");
  if (failed === 0 && applied) {
    console.log(`全部 ${captured.length} 个工具的 schema 通过 DSH 编译器校验`);
  } else {
    console.log(`${failed} 个工具未通过` + (applied ? "" : "（apply 本身失败）"));
    process.exitCode = 1;
  }
}

/** Import index.js with Harness packages replaced by inert stubs. */
async function importWithStubs() {
  const source = readFileSync(join(root, "index.js"), "utf8");

  // `Config` is schemastery; the compiler under test only cares about tool
  // schemas, so a chainable no-op stands in for it.
  const noop = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "default") return () => noop;
        return (..._args) => noop;
      },
    },
  );

  const patched = source
    .replace(/import z from "@deepseek-ai\/schemastery";/, "const z = globalThis.__z;")
    // zod is a real dependency and installs with the package, but it is absent
    // from the workspace, so stub it for the offline compiler run. Projection
    // schemas are not compiled by `defineTool`, which is what this validates.
    .replace(/import \{ z as zod \} from "zod";/, "const zod = globalThis.__z;")
    .replace(
      /import \{ defineTool \} from "@deepseek-ai\/dsh-tools";/,
      "const defineTool = (d) => { globalThis.__capture.push(d); return d; };",
    );

  globalThis.__z = noop;

  // The stub must live beside index.js so its relative imports (./lib/*) still
  // resolve; a temp file elsewhere breaks them.
  const tmp = join(root, ".index-check.mjs");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tmp, patched, "utf8");
  try {
    return await import(new URL(`file:///${tmp.replace(/\\/g, "/").replace(/ /g, "%20")}`).href);
  } finally {
    unlinkSync(tmp);
  }
}

/** Minimal service surface `apply` touches. */
function makeStubContext(captured) {
  globalThis.__capture = captured;
  return {
    systemPrompt: { section() {} },
    tools: { register: (definition) => captured.push(definition) },
    get: () => undefined,
    effect: (fn) => {
      try {
        fn();
      } catch {
        /* stub */
      }
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
