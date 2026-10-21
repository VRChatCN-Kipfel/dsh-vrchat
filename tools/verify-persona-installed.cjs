/** Validate the INSTALLED generation's patch and persona, using the real parser. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const generationsLib = require("./lib-generation.cjs");

const target = generationsLib.newestGeneration("dsh-vrchat-kb+");
if (target === null) {
  console.log("找不到已安装代");
  process.exit(1);
}
const pkgRoot = path.join(generationsLib.liveRoot(), target, "node_modules", "dsh-vrchat-kb");
console.log(`代: ${target}`);

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");
const patch = YAML.parse(fs.readFileSync(path.join(pkgRoot, "cordis.patch.yml"), "utf8"));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check("YAML 可解析", Array.isArray(patch));
const rows = patch[0]?.insert ?? [];
// Only the preset row ships: a session that never opts in pays nothing.
check("只有预设行（无全局行）", rows.length === 1, `${rows.length} 行`);
check("不含全局 vrchat-kb 行", rows.every((entry) => entry.id !== "vrchat-kb"));

const preset = rows.find((entry) => entry.id === "preset-vrchat");
check("预设存在", preset !== undefined);
check("预设 id = vrchat", preset?.config?.id === "vrchat");
check("预设含两个插件", (preset?.config?.plugins?.length ?? 0) === 2, String(preset?.config?.plugins?.length));

const persona = preset?.config?.plugins?.find((plugin) => plugin.id === "persona");
const prefix = persona?.config?.prefix;
check("persona 行存在且 prefix 是字符串", typeof prefix === "string");

if (typeof prefix === "string") {
  check("prefix 非空", prefix.trim().length > 200, `${prefix.length} 字符`);
  check("首行是专家声明", prefix.startsWith("你是 VRChat"), prefix.split("\n")[0]);
  check("保留 {{cwd}}", prefix.includes("{{cwd}}"));
  check("保留章节标题", (prefix.match(/^## /gm) ?? []).length >= 4);
  check("保留列表项", (prefix.match(/^- /gm) ?? []).length >= 8);
  check("保留行内代码", prefix.includes("`DataList`"));
  check("保留加粗", prefix.includes("**PC 与 Quest"));
  check("续行未截断", prefix.includes("SendCustomEventDelayedSeconds"));
  check("提到四个工具", ["vrchat_kb_api", "vrchat_kb_grep", "vrchat_kb_read", "vrchat_kb_scan"].every((t) => prefix.includes(t)));
  check("无转义残留", !prefix.includes("\\n"));
}

const suffix = persona?.config?.suffix;
check("suffix 随包且非空", typeof suffix === "string" && suffix.trim().length > 1000, `${suffix?.length ?? 0} 字符`);
if (typeof suffix === "string") {
  check("suffix 含红线标题", suffix.includes("# VRChat 硬约束与领域知识"));
  check("suffix 含 10 条红线", (suffix.match(/^\| \d+ \|/gm) ?? []).length >= 10);
  check("suffix 含域块分隔", suffix.includes("\n---\n"));
  check("suffix 无转义残留", !suffix.includes("\\n"));
}

const dataPersona = path.join(pkgRoot, "data", "persona-prefix.txt");
check("data/persona-prefix.txt 随包", fs.existsSync(dataPersona));
check("data/persona-suffix.txt 随包", fs.existsSync(path.join(pkgRoot, "data", "persona-suffix.txt")));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
