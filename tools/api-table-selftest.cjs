/**
 * Offline self-test for the API availability table.
 *
 * The core requirement is HONESTY: the source document lists only exposed
 * members, so "not listed" must never be reported as "unavailable". These
 * checks pin that distinction, because collapsing it would turn a gap in the
 * data into a fabricated constraint.
 *
 * Usage: node tools/api-table-selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SOURCE = path.join(
  __dirname,
  "..",
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
  "entities",
  "api",
  "exposed-types.md",
);

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "api-table.js")).href);
  const parsed = mod.parseExposedTypes(fs.readFileSync(SOURCE, "utf8"));
  const index = mod.buildIndex(parsed);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── parser ──────────────────────────────────────────────────────────────
  check("解析出全部 80 个类型节", parsed.types.length === 80, String(parsed.types.length));

  const memberTotal = parsed.types.reduce((acc, type) => acc + type.members.length, 0);
  check("解析出 1200+ 成员", memberTotal > 1200, String(memberTotal));

  const unparsed = parsed.types.flatMap((type) => type.members.filter((m) => m.kind === "unknown"));
  check("没有解析失败的成员行", unparsed.length === 0, String(unparsed.length));

  const gameObject = parsed.types.find((type) => type.type === "GameObject");
  check("类型元数据完整", gameObject !== undefined && gameObject.exposureRate === 50 && gameObject.fullName === "Playables.GameObject");

  const getComponent = gameObject?.members.filter((m) => m.name === "GetComponent");
  check("同名重载被完整保留", getComponent !== undefined && getComponent.length >= 3, `${getComponent?.length} 个`);

  const field = gameObject?.members.find((m) => m.kind === "field");
  check("字段/属性行能解析", field !== undefined, field?.raw);

  // ── lookup: exposed ────────────────────────────────────────────────────
  const exposed = mod.lookup(index, "GameObject.transform");
  check("已暴露成员判定为 exposed", exposed.verdict === "exposed", exposed.verdict);
  check("给出类型归属", exposed.type === "GameObject", exposed.type);

  const decorated = mod.lookup(index, "`UnityEngine.GameObject.GetComponent()`");
  check("带反引号与命名空间也能查", decorated.verdict === "exposed", decorated.verdict);

  const bare = mod.lookup(index, "transform");
  check(
    "裸成员名：既是类型又是成员时两者都给",
    bare.verdict === "type-and-member",
    bare.verdict,
  );
  check("同时给出类型信息与成员归属", typeof bare.exposureRate === "number" && Array.isArray(bare.overloads), bare.reason?.slice(0, 60));

  const pureMember = mod.lookup(index, "GetComponentInChildren");
  check("纯成员名（非类型名）判定为 exposed", pureMember.verdict === "exposed", pureMember.verdict);

  // ── lookup: type ────────────────────────────────────────────────────────
  // A type whose NAME is not also a member name, so it resolves as a pure type.
  const pureType = parsed.types.find(
    (type) => !index.byMember.has(type.type.toLowerCase()) && type.type !== "Transform",
  );
  const asType = mod.lookup(index, pureType.type);
  check("纯类型查询返回 type", asType.verdict === "type", `${pureType.type} → ${asType.verdict}`);
  check("类型查询带暴露率", typeof asType.exposureRate === "number", String(asType.exposureRate));
  check("类型查询列出成员", Array.isArray(asType.members) && asType.members.length > 0);
  check(
    "说明本页只列已暴露成员",
    /本页列出/.test(asType.reason) && /暴露率/.test(asType.reason),
    asType.reason,
  );

  // A type name that IS also a member name must report both, not one.
  const both = mod.lookup(index, "Transform");
  check("类型名同时是成员名时两者都给", both.verdict === "type-and-member", both.verdict);

  // ── lookup: not listed must NOT claim unavailable ───────────────────────
  const notListed = mod.lookup(index, "Component.CompareTag");
  check("类型已知但成员未列 → not-listed", notListed.verdict === "not-listed", notListed.verdict);
  check(
    "明确说明未列不等于不可用",
    /这不等于不可用/.test(notListed.reason),
    notListed.reason.slice(0, 80),
  );
  check(
    "给出未暴露数据缺失的原因",
    /没有导出数据/.test(notListed.reason) && /基类/.test(notListed.reason),
  );
  check("提供同类型已暴露成员作参照", Array.isArray(notListed.siblingMembers) && notListed.siblingMembers.length > 0);

  // ── lookup: unknown type ───────────────────────────────────────────────
  const unknownType = mod.lookup(index, "SomeMadeUpType.DoThing");
  check("未知类型 → unknown", unknownType.verdict === "unknown", unknownType.verdict);
  check("明确说无法判断而非不可用", /无法判断/.test(unknownType.reason), unknownType.reason);

  // ── honesty guard: the three verdicts must stay distinct ───────────────
  const verdicts = new Set(
    [
      "GameObject.transform", // exposed
      "Component.CompareTag", // not-listed
      "Nope.Nothing", // unknown
      pureType.type, // type
      "transform", // type-and-member
    ].map((query) => mod.lookup(index, query).verdict),
  );
  check(
    "五种状态齐全且互不混淆",
    verdicts.size === 5 &&
      verdicts.has("exposed") &&
      verdicts.has("not-listed") &&
      verdicts.has("unknown") &&
      verdicts.has("type") &&
      verdicts.has("type-and-member"),
    [...verdicts].join(","),
  );

  // ── edge cases ──────────────────────────────────────────────────────────
  check("空查询安全", mod.lookup(index, "  ").verdict === "unknown");
  check("未知成员不带类型也不知道", mod.lookup(index, "zzzNotAMember").verdict === "unknown");

  const caseInsensitive = mod.lookup(index, "gameobject.TRANSFORM");
  check("大小写不敏感", caseInsensitive.verdict === "exposed", caseInsensitive.verdict);

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
