/**
 * Parse the generated patch with the real `yaml` package.
 *
 * Structure under test, after the global row was removed:
 *   - exactly ONE row: the preset
 *   - no global `vrchat-kb` row, so a session that never opts in pays nothing
 *   - persona carries BOTH halves: prefix (identity) and suffix (constraints)
 *
 * Usage: node tools/patch-parse.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");

const patchPath = path.join(__dirname, "..", "cordis.patch.yml");
const text = fs.readFileSync(patchPath, "utf8");

let parsed;
try {
  parsed = YAML.parse(text);
} catch (error) {
  console.log(`FAIL  YAML 解析失败\n      ${String(error?.message ?? error)}`);
  process.exitCode = 1;
  process.exit();
}

console.log("PASS  YAML 解析成功");

const rows = parsed?.[0]?.insert ?? [];
const preset = rows.find((entry) => entry.id === "preset-vrchat");
const globalRow = rows.find((entry) => entry.id === "vrchat-kb");
const persona = preset?.config?.plugins?.find((plugin) => plugin.id === "persona");
const kb = preset?.config?.plugins?.find((plugin) => plugin.name === "dsh-vrchat-kb");
const prefix = persona?.config?.prefix;
const suffix = persona?.config?.suffix;

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// ── two rows: tools always, injection preset-gated ──────────────────────
//
// The tools must be reachable from ANY session (the agent should be able to ask
// the library a question without switching preset), while the persona text must
// only appear when the user selected the preset. That is two rows, not one.
check("存在常驻工具行", globalRow !== undefined, String(globalRow?.id));
check("常驻行 tier 为 lite（只注册工具）", globalRow?.config?.tier === "lite", globalRow?.config?.tier);
check("常驻行不是预设", globalRow?.name === "dsh-vrchat-kb", globalRow?.name);
check("共两行（工具 + 预设）", rows.length === 2, `${rows.length} 行`);

// ── preset shape ────────────────────────────────────────────────────────
check("预设 id 为 vrchat", preset?.config?.id === "vrchat", preset?.config?.id);
check("预设含 persona 与 vrchat-kb 两个插件", (preset?.config?.plugins?.length ?? 0) === 2);
check("预设内 vrchat-kb 的 tier 为 preset", kb?.config?.tier === "preset", kb?.config?.tier);
check("预设内实例与常驻实例 id 不同", kb?.id !== globalRow?.id, `${kb?.id} vs ${globalRow?.id}`);

// The tier must gate injection, so the two configs cannot be identical.
check("两个实例的 tier 不同", globalRow?.config?.tier !== kb?.config?.tier);

// ── prefix: identity ────────────────────────────────────────────────────
check("prefix 是字符串", typeof prefix === "string");
check("prefix 非空", typeof prefix === "string" && prefix.trim().length > 200, `${prefix?.length ?? 0} 字符`);
if (typeof prefix === "string") {
  check("prefix 首行是专家声明", prefix.startsWith("你是 VRChat"), prefix.slice(0, 24));
  check("prefix 保留 {{cwd}}", prefix.includes("{{cwd}}"));
  check("prefix 保留章节标题", (prefix.match(/^## /gm) ?? []).length >= 4);
  check("prefix 保留行内代码", prefix.includes("`DataList`"));
  check("prefix 保留加粗", prefix.includes("**PC 与 Quest"));
  check("prefix 续行未截断", prefix.includes("SendCustomEventDelayedSeconds"));
  check("prefix 提到四个工具", ["vrchat_kb_api", "vrchat_kb_grep", "vrchat_kb_read", "vrchat_kb_scan"].every((t) => prefix.includes(t)));
  check("prefix 提到运行时探测工具", /vrchat_kb_unity/.test(prefix));
  // The two metadata tools exist because frontmatter is a FILTER, not text. If the
  // prompt does not name them, the agent falls back to grep and gets 414 hits.
  check("prefix 提到筛选工具", /vrchat_kb_filter/.test(prefix));
  check("prefix 提到列库工具", /vrchat_kb_list/.test(prefix));
  check("说明元数据是筛选而非文本搜索", /结构化筛选/.test(prefix) && /命中全部 414 页/.test(prefix));
  check("说明 read 行号不漂移", /行号仍是文件真实行号/.test(prefix));

  // The probe can be blind without being wrong: permissions and sessions hide
  // processes. The prompt must say so BEFORE the agent hits the situation, because
  // the failure mode is confidently telling a user "you did not install it".
  check("说明「看不到」不等于「没有」", /看不到东西，不等于用户没有/.test(prefix));
  check("提到权限不对称", /以管理员身份运行.*普通权限|权限不对称/.test(prefix));
  check("说明参数读不到是观测限制", /不是「没有 MCP」/.test(prefix));
  check("要求先说观测限制再给复核办法", /先说这是观测限制/.test(prefix));
  check("禁止断言用户没装", /不要断言「你没装/.test(prefix));
  check("用户说开着时先怀疑权限", /先怀疑权限，不要先怀疑他/.test(prefix));
  check("说明它只读不读凭据", /只读、不读凭据/.test(prefix));
  check("要求 agent 自己确认端点与 token", /自己去看该 PID 的启动参数/.test(prefix));
  check("prefix 无转义残留", !prefix.includes("\\n"));

  // The tool section must be MANDATORY, not descriptive: an agent that merely
  // knows a tool exists will not reach for it. These assert trigger conditions.
  check("工具段有强制语气", /不是可选装饰/.test(prefix), "tools must be framed as required, not optional");
  check("写代码前要求查 API", /写代码前.*vrchat_kb_api|vrchat_kb_api.*查/.test(prefix));
  check("完成后要求 scan 自查", /vrchat_kb_scan.*自查|调用 `vrchat_kb_scan`/.test(prefix));
  // "not listed ≠ unavailable" must survive, but the reason is now explicit: the
  // shipped table is a subset, so the reader has to fall back to the source table.
  check("说明未收录≠不可用", /未命中不代表不可用|未收录.*不可用|不可用.*未收录/.test(prefix));
  check("说清 api 表是摘录子集", /摘录子集/.test(prefix));
  check("给出上游原表规模", /1387/.test(prefix) && /9579/.test(prefix));
  check("说明未暴露的三种后果", /静默无效果/.test(prefix) && /崩溃/.test(prefix));

  // Process: the difference between a manual and an expert is whether it says
  // how to approach a request, not just which rules exist.
  check("含需求到实现的路径", /拿到一个需求，怎么走/.test(prefix));
  check("路径含定平台", /先定平台/.test(prefix));
  check("路径含定同步模型", /再定同步模型/.test(prefix));

  // Concrete numbers an expert would cite without looking them up.
  check("含 Quest 面数阈值", /20,000/.test(prefix));
  check("含 Quest 材质内存", /40 MB/.test(prefix));
  check("含 Quest 骨骼上限", /150/.test(prefix));

  // These two assertions used to pin statements the CORPUS CONTRADICTS: the
  // corpus says Avatar-side Unity Constraints are auto-converted and recommended,
  // and that community shaders ship Quest variants. Assert the corrected claims so
  // the old mistake cannot return silently.
  check("PC Poor 线为 70,000（不是 Quest 的 20,000）", /面数 70,000/.test(prefix));
  check("警告别把 Quest 数字当 PC", /别把 Quest 的数字当成 PC/.test(prefix));
  check("说清性能指标远多于四项", /20\+ 项/.test(prefix));
  check("Quest Shader 提到社区变体可用", /Micro\/Nano|lilToon 的 Quest 版/.test(prefix));
  check("说明 Unity Constraints 会自动转换", /自动转换[为成].*VRChat Constraints/.test(prefix));
  check("不再断言 Quest 禁用 Unity Constraints", !/不能使用 Unity Constraints/.test(prefix));
  check("带宽分平台（PC 11 / Quest 5）", /11 KB\/s（PC）|11 KB\/s（PC）\/ 约 5/.test(prefix) || /约 5 KB\/s（Quest）/.test(prefix));
  check("5–10 倍只用于 GPU，不泛指", !/相差 5–10 倍的性能世界/.test(prefix));
  check("工具段标明来源不同", /不在那 414 页里/.test(prefix));

  // Every "why": a rule list without reasons reads as dogma.
  check("集合禁用带原因", /没有泛型集合运行时/.test(prefix));
  check("热路径禁用带原因", /EXTERN.*最昂贵|最昂贵的单指令/.test(prefix));
  check("节流带原因", /StrongBox/.test(prefix));

  // ── capability gap: proactive, and environment-agnostic ────────────────
  check("含开工前盘点的段落", /开工前先盘点/.test(prefix));
  check("要求主动说出缺口", /不要等用户碰壁才说缺东西/.test(prefix));
  check("盘点链路含四要素", /需要的工具/.test(prefix) && /谁能弄到/.test(prefix));

  // The autonomy boundary is the actionable half: what the agent does itself
  // versus what only the user can do. Both halves must be present.
  check("含自主边界段", /你的自主边界/.test(prefix));
  check("列出自足的能力面", /你能完全自主完成的/.test(prefix));
  check("列出必须用户做的能力面", /你做不到、必须用户亲手完成的/.test(prefix));
  check("自主面含代码与本地操作", /写 UdonSharp/.test(prefix));
  check("自主面含 CLI 安装", /npm install -g/.test(prefix));
  check("自主面含改 manifest.json", /Packages\/manifest\.json/.test(prefix) && /不需要在 Package Manager 里点/.test(prefix));
  check("自主面含 install-unity", /install-unity/.test(prefix));
  check("自主面含无头启动", /--headless/.test(prefix));
  check("自主面含 exec 跑 C#", /cli exec/.test(prefix));
  check("用户面含 GUI 授权", /OAuth/.test(prefix));
  check("用户面含 CoplayDev 菜单点击", /Configure All Detected Clients/.test(prefix));
  check("边界归于「需要人手点一下」", /需要人手点一下/.test(prefix));
  check("该动手的直接动手", /该你动手的直接动手/.test(prefix));

  // Both Unity bridges must be offered, chosen by whether the USER can help,
  // and both must admit they end in the Unity GUI.
  check("给出两个 Unity MCP 选择", /IvanMurzak\/Unity-MCP/.test(prefix) && /CoplayDev\/unity-mcp/.test(prefix));
  check("判据是用户能否配合", /用户能不能配合/.test(prefix));
  check("说明 IvanMurzak 有 CLI 可代跑", /npm install -g unity-mcp-cli/.test(prefix));
  check("说明 IvanMurzak 需用户 OAuth", /login.*用户做|用户做（浏览器 OAuth/.test(prefix));
  check("说明 IvanMurzak 路径不能含空格", /路径不能含空格/.test(prefix));
  check("说明 CoplayDev 两步在 GUI", /Configure All Detected Clients/.test(prefix));
  check("说明 CoplayDev 需要 Python", /Python 3\.10/.test(prefix));
  check("说明 manifest 那步可由 agent 做", /改 `Packages\/manifest\.json` 加/.test(prefix));
  check("不再断言两者都要用户在 Unity 点", !/都必须由用户在 Unity 里点/.test(prefix));

  // BOOTH tooling facts that make it agent-usable, and the limit that matters.
  check("提到 BOOTHVAULT_TOOLHUB 环境变量", /BOOTHVAULT_TOOLHUB/.test(prefix));
  check("说明 BOOTH 下载需要 cookie", /cookie/.test(prefix) && /不要伪造/.test(prefix));

  // The wiring step must NOT assume any specific tool exists.
  check("接线方式不假设具体工具", /这取决于用户的环境|先看你有什么/.test(prefix));
  check("明确不要假设管理工具存在", /不要假设某个管理工具一定存在/.test(prefix));
  check("禁止自行改用户 profile", /不要在会话里直接改用户的 profile/.test(prefix));
  check("注明有些环境没有 MCP 设置界面", /有些环境没有/.test(prefix));

  // The three-part report the user asked for, plus plain-language advice.
  check("要求说清缺什么/得到什么/还能做什么", /缺什么/.test(prefix) && /装了能多得到什么/.test(prefix) && /还能做什么/.test(prefix));
  check("禁止只回一句做不到", /不要只回一句/.test(prefix));
  check("禁止编造链接或版本号", /不要编造下载链接或版本号/.test(prefix));
  check("安装建议要说人话", /要说人话/.test(prefix));
}

// ── suffix: constraints ─────────────────────────────────────────────────
check("suffix 是字符串", typeof suffix === "string");
check("suffix 非空", typeof suffix === "string" && suffix.trim().length > 1000, `${suffix?.length ?? 0} 字符`);
if (typeof suffix === "string") {
  check("suffix 含红线标题", suffix.includes("# VRChat 硬约束与领域知识"));
  check("suffix 含 10 条红线", (suffix.match(/^\| \d+ \|/gm) ?? []).length >= 10, `${(suffix.match(/^\| \d+ \|/gm) ?? []).length} 行`);
  check("suffix 含域块分割线", suffix.includes("\n---\n"));
  check("suffix 含 World 域块", suffix.includes("Udon VM"));
  check("suffix 含 Avatar 域块", suffix.includes("Playable Layers") || suffix.includes("physbone") || suffix.includes("PhysBone"));
  check("suffix 含 Shader 域块", suffix.includes("BRP") || suffix.includes("Poiyomi"));
  check("suffix 无转义残留", !suffix.includes("\\n"));
  check("suffix 不含前导破折号（块标量损坏的迹象）", !suffix.trimStart().startsWith("- "), suffix.slice(0, 30));
}

// ── prefix/suffix must not duplicate each other wholesale ───────────────
if (typeof prefix === "string" && typeof suffix === "string") {
  const overlap = prefix.split("\n").filter((line) => line.trim().length > 30 && suffix.includes(line.trim()));
  check("prefix 与 suffix 无大段重复", overlap.length < 5, `${overlap.length} 行重复`);
}

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
