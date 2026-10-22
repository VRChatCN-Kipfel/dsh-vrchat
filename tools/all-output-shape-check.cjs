/**
 * Sweep every tool's return shape for `undefined` properties.
 *
 * `read` was one instance of a class of bug, not a unique accident: any tool
 * whose declared output schema lists keys it does not always populate produces
 * undefined properties, and `dsh-tools` rejects the whole result with
 * INVALID_TOOL_OUTPUT. So check all of them against the REAL validator.
 *
 * Usage: node tools/all-output-shape-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const hostModules = "D:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules";
const requireHost = createRequire(path.join(hostModules, "noop.js"));
const { isJsonValue } = requireHost("@deepseek-ai/dsh-util-values");

async function main() {
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);
  const lint = await import(pathToFileURL(path.join(root, "lib", "lint.js")).href);
  const apiTable = await import(pathToFileURL(path.join(root, "lib", "api-table.js")).href);

  const store = search.createStore(path.join(root, "data"), search.findCorpusRoot(root));
  const paths = store.index.map((entry) => entry.path);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  /** Report undefined-valued keys of one candidate return value. */
  const undefinedKeys = (value) =>
    value === null || typeof value !== "object"
      ? []
      : Object.entries(value)
          .filter(([, v]) => v === undefined)
          .map(([k]) => k);

  const assertValid = (label, value) => {
    const keys = undefinedKeys(value);
    check(`${label} 输出合法`, isJsonValue(value), keys.length > 0 ? `undefined: ${keys.join(", ")}` : "ok");
  };

  // ── vrchat_kb : hit and miss ────────────────────────────────────────────
  const kbHit = search.answer(store, "Udon 同步变量", { limit: 2, charBudget: 1200 });
  assertValid("vrchat_kb（命中）", { text: kbHit.text, hit: kbHit.hit, pageCount: kbHit.pageCount, routes: kbHit.routes });
  const kbMiss = search.answer(store, "今天天气怎么样", { limit: 2, charBudget: 1200 });
  assertValid("vrchat_kb（未命中）", { text: kbMiss.text, hit: kbMiss.hit, pageCount: kbMiss.pageCount, routes: kbMiss.routes });

  // ── vrchat_kb_grep : hit and miss ───────────────────────────────────────
  const grepHit = docs.grepPages(paths, store.bodyOf, "Udon", { maxMatches: 3 });
  assertValid("vrchat_kb_grep（命中）", {
    text: grepHit.text,
    ok: grepHit.ok,
    total: grepHit.total ?? 0,
    matches: grepHit.matches ?? [],
  });
  const grepMiss = docs.grepPages(paths, store.bodyOf, "zzz-not-there-zzz");
  assertValid("vrchat_kb_grep（未命中）", {
    text: grepMiss.text,
    ok: grepMiss.ok,
    total: grepMiss.total ?? 0,
    matches: grepMiss.matches ?? [],
  });

  // ── vrchat_kb_read : the four shapes ───────────────────────────────────
  const readOk = docs.readPage(store.bodyOf, paths, "entities/api/not-exposed.md", 1, 5);
  assertValid("vrchat_kb_read（成功）", {
    text: readOk.text,
    ok: readOk.ok,
    path: readOk.path,
    offset: readOk.offset,
    totalLines: readOk.totalLines,
    lines: readOk.lines,
  });
  for (const [label, result] of Object.entries({
    路径不在库里: docs.readPage(store.bodyOf, paths, "no/such/page.md"),
    offset越界: docs.readPage(store.bodyOf, paths, "entities/api/not-exposed.md", 99999, 5),
    语料缺失: docs.readPage(() => null, paths, "entities/api/not-exposed.md"),
  })) {
    assertValid(`vrchat_kb_read（${label}）`, {
      text: result.text,
      ok: result.ok,
      path: result.path,
      offset: result.offset,
      totalLines: result.totalLines,
      lines: result.lines,
    });
  }

  // ── vrchat_kb_api : all five verdicts ──────────────────────────────────
  const table = JSON.parse(fs.readFileSync(path.join(root, "data", "api-table.json"), "utf8"));
  const index = apiTable.buildIndex({
    types: (table.types ?? []).map((type) => ({
      ...type,
      members: (type.members ?? []).map((member) => ({ raw: member.raw, name: member.name, kind: member.kind, params: [] })),
    })),
  });
  for (const query of ["Transform", "GetComponent", "Physics.SphereCast", "Transform.position", "NotAThing"]) {
    const verdict = apiTable.lookup(index, query);
    // index.js returns exactly { text, verdict }.
    check(`vrchat_kb_api（${query}）有 verdict`, typeof verdict.verdict === "string", verdict.verdict);
    assertValid(`vrchat_kb_api（${query}）`, { text: "x", verdict: verdict.verdict });
  }

  // ── vrchat_kb_scan : findings and clean ────────────────────────────────
  const dirty = lint.lintSource("x.cs", "using System.Collections.Generic;\nclass A { List<int> f; }");
  assertValid("vrchat_kb_scan（有发现）", { text: "x", findings: dirty.findings ?? [], count: (dirty.findings ?? []).length });
  const clean = lint.lintSource("y.cs", "class B { int[] a = new int[4]; }");
  assertValid("vrchat_kb_scan（干净）", { text: "x", findings: clean.findings ?? [], count: (clean.findings ?? []).length });

  // ── the declared output schemas vs what is actually returned ───────────
  //
  // A schema key that is `required: true` must ALWAYS be present; a key that is
  // only sometimes present must be optional. This catches the inverse mistake.
  const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const requiredNeverUndefined = [
    /text: \{ type: "string", required: true \}/.test(indexSource),
    /hit: \{ type: "boolean", required: true \}/.test(indexSource),
    /ok: \{ type: "boolean", required: true \}/.test(indexSource),
  ];
  check("关键输出键在 schema 里是 required", requiredNeverUndefined.every(Boolean));
  check("read 的失败分支已补齐四键", /path: null, offset: null, totalLines: null, lines: \[\]/.test(fs.readFileSync(path.join(root, "lib", "docs.js"), "utf8")));

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
