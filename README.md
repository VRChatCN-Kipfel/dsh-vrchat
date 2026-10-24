# dsh-vrchat

VRChat 创作者工具链：**414 页知识库 + 红线主动注入 + 9 个专用工具 + 6 个随包技能**。

## 为什么这样分工

导航类内容（文件清单、目录树、索引页）**一旦嵌进 prompt，就抢走了"由查询决定返回什么"的能力**。
所以：

| 谁 | 负责什么 | 载体 |
|---|---|---|
| **注入** | "有什么" —— 红线、硬约束、覆盖边界 | `systemPrompt.section` |
| **工具** | "在哪、具体是什么" —— 定位与取原文 | `vrchat_kb` |

agent 不需要知道 `entities/world/udon/persistence/index.md` 存在，只需要知道可以问。

## 两种模式（靠同名 section shadow 实现，无模式判断代码）

| 模式 | 触发 | 注入内容 | 估算 |
|---|---|---|---|
| 默认（`tier: lite`，常驻） | 任意会话 | **不注入任何 prompt 文本**，只注册 9 个工具与 `/vrchat` | 工具定义 ~2–3K tok |
| VRChat 创作预设（`tier: preset`） | 选用 `vrchat` 预设 | 红线 + 覆盖地图 + World/Avatar/Shader 全量域块 | prefix 4.5–6.9k + suffix 2.7–3.9k tok |

**注入由预设门控，工具不门控。** 常驻行（`tier: lite`）在任何会话都挂上，所以 agent 随时可以
向知识库提问；它之所以不注入，是因为「VRChat 专家」这个身份只在用户选了预设时才成立。

`full` 是 `preset` 的兼容别名（行为完全相同），新配置不要再写 `full`。

八个查库工具：`vrchat_kb`（概念）/ `_grep`（定位给行号）/ `_read`（按行读上下文）/ `_api`（是否在
Udon 暴露）/ `_filter`（按元数据筛）/ `_list`（库概况）/ `_unity`（Unity 运行时与许可证）/
`_scan`（产出代码违例自查）。

第九个是 `_project_new`：**创建一个最小 VRChat 工程骨架**（World / Avatar）。它不查库，
补的是「一句话需求 → 从零起工程」这一步——ALCOM 的建工程能力只在 GUI 里，`vrc-get` 没有
创建子命令，所以此前 agent 无法自己开工程。它只写文本文件（三个目录 + `ProjectVersion.txt`
+ 两个包清单，取自上游 `project-templates`），不联网、不启动 Unity、不装 SDK；SDK 由
`vrc-get resolve` 补齐。目标已存在时默认拒绝并列出内容，`force: true` 才覆盖（先备份为
`<目录>.bak-<时间戳>`，不删除）。

**注入在哪一块什么内容**（`docs/vrchat-kb-architecture.md` §2 详解）：

| 位置 | 内容 | 规模 |
|---|---|---|
| persona `prefix`（order 0） | 专家身份 / 领域事实 / 域边界 / 工具索引 | 10,835 字符 |
| persona `suffix`（order 10200） | 10 条红线 + 三个域块 | 7,964 字符 |
| `vrchat-kb` section（order 640） | 只有状态标注与分流指引，**不复制红线** | 551 字符 |

order 640 曾经内联 `t0-core + always-load`，而 suffix 已逐字带上同样内容 —— 99.6% 重合，
每次预设会话白烧约 2700–4000 tok。现在红线只存在一处。

## 技能（两套，同为 submodule，原样引入不改上游）

预设在挂载知识库之外，还通过 `skill-filesystem` 挂两套技能。二者职责**不重叠**，这也是它们能共存的前提：

| 根 | 内容 | 管什么 |
|---|---|---|
| `vendor/vrchat-world-codex-skills/` | 入口 `vrchat-world` + 3 个子技能 | **World / Udon** 的设计—实施—核验流程 |
| `vendor/vrchat-editor-skill/` | 单个技能 `inspect-vrchat-avatar-project` | **Avatar** 的检查/诊断/审计流程 + 三份 provider 手册 |

**分工：知识库管事实，技能管流程。** 参数是多少、API 是否暴露、组件语义 —— 查库；
「改这个之前先建什么责任矩阵、按什么顺序查、过哪张验收表」 —— 走技能。
语料里的 `entities/avatar/avatar-audit-methodology.md` 是编辑器技能的中文本地化压缩版，
只作速查；两者冲突以技能为准（这条写进了 order 640 的注入段）。

两套技能都由 `cordis.patch.yml` 里 `vrchat-skills` 的 `customSkillDirs` 以 `!!js` 表达式在
**运行时**解析（`new URL(..., baseUrl)`），不硬编码任何安装路径。

**描述上限调到 1024。** catalogue 每行是 `- \`name\`: description`，默认截断在 500 字符，
而这一行是模型**唯一**的路由依据。编辑器技能的描述是 795 字符，最后一句正是
「Do not use for VRChat World or Udon projects」—— 在 500 处刚好被砍掉，于是它会去抢 World 请求。
修法是调 `tool-skill` 的 `catalogDescriptionMaxLength`（**只在本预设的实例上**，不影响标准模式），
**不是**去改上游文件。顺带也修好了 4 个被同样截断的用户技能。

> 技能里的「必须 Unity MCP」是**标注义务，不是安装义务**：没连上编辑器就照常做静态取证，
> 但结论必须标 `STATIC_SOURCE` / `MCP_REQUIRED` / `BLOCKED`，不许升格、不许写 `PASS`。
> 装不装桥、走 CLI 还是 batch-mode 由使用者按条件决定。直到 0.29.0 预设里**没有** `mcp-client` 行 —
> 里面的 Unity 能力是 `vrchat_kb_unity`（只读进程/许可证探测）+ shell/fs，不是编辑器工具。

## 数据

两类东西，归属不同：

**语料本体 —— `VRChat-Agent-Creator-Library/`（submodule，随包分发）**
414 个裸 Markdown。它是插件本体的一部分，**不经 `data/`、不被重新序列化**：
查询时按需打开命中的那几页（`lib/search.js` 的惰性读取）。

**派生数据 —— `data/`（构建产物，随包分发）**

| 文件 | 内容 |
|---|---|
| `t0-core.txt` | 红线注入块（手写策展） |
| `t1-{world,avatar,shader}.txt` | 域块（手写策展） |
| `domain-map.txt` | 覆盖地图 + 不覆盖声明 |
| `always-load.txt` | 预设模式主体 |
| `index.json` | 414 页元数据 + 上游 `confidence`（不含正文） |
| `api-table.json` | SDK 3.10.3 已暴露清单（80 类型 / 1253 成员，解析自 `entities/api/exposed-types.md`） |
| `keyword-routes.json` | 上游 `index.md` 的话题→目录路由表（20 条，解析自 `## 搜索关键词`） |

`data/` 只放**能从语料机械推导的东西**；正文永远留在 submodule 里，不进 `data/`。

## 重建

```bash
node tools/build-knowledge.mjs     # 上游 submodule → data/（只生成派生数据）
node tools/measure-content.mjs .   # CJK/ASCII 分开的 token 估算
```

## 自测（不需要 Harness）

```bash
node tools/selftest.cjs                                   # 数据完整性 + 5 个示例查询
node tools/debug-query.cjs "Udon 同步变量 非 Owner"        # 单条查询的 token/覆盖率/路由
node tools/token-df.cjs rust 同步 quest                    # 文档频率（判断词是否可区分）
```

## 检索设计的三条硬性要求

1. **准入必须"关于"，不能"提及"**。词法重合不等于主题相同：一个讲网格简化的页面里写着"计算流水线"，
   不能用来回答 Rust CI 问题。准入 = 话题路由命中 ∪ 标题/标签命中 ∪ 单token全覆盖；只有正文命中不算。
2. **高频词不单独成事**。`udon` 56%、`同步` 48%、`quest` 37% —— 它们是主题词但无区分度，
   必须有低频词同时出现。
3. **ASCII 必须整词匹配**。子串匹配让 `rust` 命中 `Trust Rank`，这就是一个外部问题"找到"25 个页面的原因。

满足这三条之后，库外问题才会真正返回空结果，**覆盖边界回落**才有意义 ——
告诉模型"这是库的边界，不是你检索不够"，从而止住反复查询。

## 已知边界

- 检索是词法的（bigram + 文档频率），没有向量。同义改写（"角色" vs "Avatar"）靠 `keyword-routes.json` 的别名兜底，不靠语义。
- 上游更新后需重跑构建；`content-src/` 是手写策展，不会自动跟随上游变化。
- `pi-ai` 路由不支持 `deferLoading`（本插件未使用该标志）。
