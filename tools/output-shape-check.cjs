/**
 * Reproduce the undefined-property output crash, using the REAL Host validator.
 *
 * `dsh-tools` validates a tool result with `snapshotJsonValue` before `render`
 * runs. A property whose value is `undefined` is not lossless JSON, so the whole
 * call fails with INVALID_TOOL_OUTPUT and the model sees the error code instead
 * of the message the tool carefully composed.
 *
 * The real `isJsonValue` comes from the installed Host packages, so this is not a
 * guess about its behaviour.
 *
 * Usage: node tools/output-shape-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
// Resolve the Host rather than hardcoding its install path — see lib-host-modules.cjs.
const requireHost = require("./lib-host-modules.cjs").hostRequireFactory();

async function main() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── the real validator ─────────────────────────────────────────────────
  let isJsonValue;
  try {
    ({ isJsonValue } = requireHost("@deepseek-ai/dsh-util-values"));
    check("导入真实 isJsonValue", typeof isJsonValue === "function");
  } catch (error) {
    check("导入真实 isJsonValue", false, String(error?.message ?? error));
  }

  if (typeof isJsonValue === "function") {
    const broken = { text: "boom", ok: false, path: undefined, offset: 1 };
    check("含 undefined 属性的对象不是 lossless JSON", isJsonValue(broken) === false);
    check("改为 null 就合法", isJsonValue({ text: "boom", ok: false, path: null, offset: 1 }) === true);
    check("省略该键也合法", isJsonValue({ text: "boom", ok: false, offset: 1 }) === true);
    check(
      "正常成功形状合法",
      isJsonValue({ text: "a", ok: true, path: "x", offset: 1, totalLines: 2, lines: [] }) === true,
    );
  }

  // ── does the plugin produce such a shape? ──────────────────────────────
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);

  const store = search.createStore(path.join(root, "data"), search.findCorpusRoot(root));
  const paths = store.index.map((entry) => entry.path);

  /** Mirror of index.js's return, so the check tests the real projection. */
  const project = (result) => ({
    text: result.text,
    ok: result.ok,
    path: result.path,
    offset: result.offset,
    totalLines: result.totalLines,
    lines: result.lines,
  });

  const failures = {
    "路径不在库里": docs.readPage(store.bodyOf, paths, "no/such/page.md"),
    "offset 越界": docs.readPage(store.bodyOf, paths, "entities/api/not-exposed.md", 99999, 10),
    "语料缺失": docs.readPage(() => null, paths, "entities/api/not-exposed.md"),
  };

  for (const [label, result] of Object.entries(failures)) {
    check(`失败分支「${label}」确实 ok:false`, result.ok === false, String(result.ok));
    const projected = project(result);
    const undefinedKeys = Object.entries(projected)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    const valid = typeof isJsonValue === "function" ? isJsonValue(projected) : true;
    check(
      `失败分支「${label}」→ 工具返回值合法`,
      valid,
      undefinedKeys.length > 0 ? `undefined 键：${undefinedKeys.join(", ")}` : "ok",
    );
  }

  const success = project(docs.readPage(store.bodyOf, paths, "entities/api/not-exposed.md", 1, 5));
  check("成功分支形状合法", typeof isJsonValue !== "function" || isJsonValue(success), "");

  // Keep the projection honest: it must match what index.js really returns.
  const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");
  check(
    "本测试的投影与 index.js 返回一致",
    /path: result\.path,\s*\n\s*offset: result\.offset,\s*\n\s*totalLines: result\.totalLines,\s*\n\s*lines: result\.lines,/.test(
      indexSource,
    ),
    "若 index.js 改了返回形状，本测试会失效",
  );

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
  console.error(error);
  process.exit(1);
});
