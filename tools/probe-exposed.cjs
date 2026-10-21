/** Validate the exposed-types parser against the real document. */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const file = path.join(
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
  const text = fs.readFileSync(file, "utf8");
  const parsed = mod.parseExposedTypes(text);

  console.log(`解析出类型节: ${parsed.types.length}`);
  let members = 0;
  for (const type of parsed.types) members += type.members.length;
  console.log(`解析出成员: ${members}`);

  console.log("");
  console.log("样本类型：");
  for (const type of parsed.types.slice(0, 5)) {
    console.log(`  ${type.type}  rate=${type.exposureRate}%  members=${type.members.length}/${type.memberCount}  full=${type.fullName}`);
  }

  console.log("");
  console.log("成员解析样本：");
  const gameObject = parsed.types.find((t) => t.type === "GameObject");
  if (gameObject !== undefined) {
    for (const member of gameObject.members.slice(0, 6)) {
      console.log(`  ${JSON.stringify(member)}`);
    }
  }

  console.log("");
  console.log("字段类成员样本：");
  const fields = parsed.types.flatMap((t) => t.members.filter((m) => m.kind === "field").map((m) => ({ type: t.type, m })));
  fields.slice(0, 5).forEach(({ type, m }) => console.log(`  ${type}.${m.name} : ${m.returnType}`));

  console.log("");
  console.log("解析失败的成员行：");
  const unknown = parsed.types.flatMap((t) => t.members.filter((m) => m.kind === "unknown").map((m) => ({ type: t.type, m })));
  console.log(`  ${unknown.length} 条`);
  unknown.slice(0, 8).forEach(({ type, m }) => console.log(`  [${type}] ${m.raw}`));

  const index = mod.buildIndex(parsed);
  console.log("");
  console.log(`索引：类型 ${index.byType.size} 个键，成员名 ${index.byMember.size} 个键`);

  for (const probe of ["destroy", "getcomponent", "comparetag", "sendmessage", "screentoworldpoint"]) {
    const hits = index.byMember.get(probe);
    console.log(`  ${probe}: ${hits === undefined ? "未收录" : hits.map((h) => h.type).join(", ")}`);
  }
}

main();
