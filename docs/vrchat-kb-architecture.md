# VRChat Agent Creator Library → DSH 知识库插件架构（v0.29）

> 状态：**已落地并在装机运行**（`dsh-vrchat-kb+0.29.0`）。本文档描述**当前实现**，不是设计稿。
> 目标：主动注入 · 节省 token · 模型愿意来问。
> 知识源：`VRChat-Agent-Creator-Library/`（git submodule，414 页 / 4023 KB）
>
> **v0.2 的设计与最终实现不同。** 三处被推翻，留档在 §11：词表门控注入、`agent/pre-step`
> 附加 T1、`tools/post-execute` 封口。它们都依赖「按轮修改 messages」，而实测发现这条路
> 的代价与风险都高于收益。**当前实现不需要它们**。

---

## 0. 一句话定义

**用两行挂载把「红线与领域事实」主动推到模型眼前，把「具体在哪一页」留给工具。**

它不是检索插件。检索是长尾兜底：`vrchat_kb` 存在的理由是让模型**不必**先去猜文件路径。

---

## 1. 两条挂载行，职责不同

`cordis.patch.yml` 只做两件事：

| 行 | tier | 作用 | 何时 |
|---|---|---|---|
| `vrchat-kb` | `lite` | 注册 8 个工具 + `/vrchat` 命令。**不注入任何 prompt 文本** | 任何会话，常驻 |
| `preset-vrchat` | `preset` | 完整 agent + VRChat persona + 知识库 + 技能 | 用户选用 VRChat 预设时 |

**工具不门控，注入门控。** 常驻行让任何会话都能向知识库提问；它不注入，是因为「VRChat
专家」这个身份只在选了预设时才成立。没选预设的会话**零字符代价**。

`full` 是 `preset` 的历史别名，行为相同；新配置只写 `preset`。

---

## 2. 注入实际发生了什么

预设模式注入两块，内容都在 `data/`：

| 位置 | 内容 | 规模 |
|---|---|---|
| persona `prefix`（order 0） | 专家身份 / 领域事实 / 域边界 / 工具索引 | 10,835 字符 ≈ 4.5–6.9k tok |
| persona `suffix`（order 10200） | 10 条红线 + World/Avatar/Shader 全量域块 | 7,964 字符 ≈ 2.7–3.9k tok |
| `vrchat-kb` section（order 640） | **只有状态标注 + 分流指引**，551 字符 | ≈ 0.2k tok |

关键决定：**order 640 的 section 不复制红线。**

它曾经重复 `t0-core + always-load`，而 suffix 已经逐字带上了同样的内容 —— 实测 99.6% 重合，
每次预设会话白烧约 2700–4000 tok，且两份同样的话只要一边被编辑就会互相矛盾。
现在红线**只存在于一处**（suffix，order 10200，prompt 的最后一句），section 只带 suffix
带不了的东西：这次加载的是哪个构建，以及事实与流程该去哪取。

`suffix` 放在最末不是随意的：它是**最终适用的约束集**。模型读到一段长 prompt 时，
最后出现的约束在生成时权重最高。

---

## 3. 组件图

```
┌─ Harness Host 进程 ──────────────────────────────────────────────────────┐
│  Bundle: dsh-vrchat-kb                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐│
│  │ cordis.patch.yml（由 tools/build-knowledge.mjs 生成，不要手改）        ││
│  │   insert:                                                            ││
│  │    ├─ vrchat-kb       config:{tier: lite}   ← 工具层，全局常驻         ││
│  │    └─ preset-vrchat   config:{plugins:[ 21 行 ]}  ← 预设，含注入        ││
│  └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  index.js  apply(ctx, config)                                            │
│  ├── storeFor()     首次调用时建 store（模块级单例，两实例天然共享）        │
│  │                  data/index.json 元数据 + 按需读 submodule 正文         │
│  ├── systemPrompt.section({name:'vrchat-kb', order:640, text})           │
│  │                  仅 tier=preset 时注册                                  │
│  ├── ctx.tools.register(×8)  vrchat_kb / _grep / _read / _api /           │
│  │                  _filter / _list / _unity / _scan                      │
│  ├── ctx.sessionProjections  vrchatKb（账本投影，供 UI 与去重）            │
│  └── ctx.commands            /vrchat                                     │
│                                                                          │
│  lib/  search / docs / metadata / api-table / lint / ledger /            │
│        unity-status                                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

预设的 21 行插件是从**已安装的 `standard` 预设**读出来再改写的，见 §7 —— 因为 agent preset
没有任何继承语法。

---

## 4. 八件工具各自解决一个具体的失败

| 工具 | 解决什么 |
|---|---|
| `vrchat_kb` | 概念检索。打分后返回**答案包**而不是片段 |
| `vrchat_kb_grep` | 精确定位符号 / 规则编号，给行号 |
| `vrchat_kb_read` | 按行号读上下文。跳过页首 YAML 但**保留真实行号**，所以 grep 的 `Line 240` 可直接 `offset=240` |
| `vrchat_kb_api` | 某 API 在 Udon 中是否暴露（80 类型 / 1253 成员）。**未收录 ≠ 不可用** |
| `vrchat_kb_filter` | 按元数据筛页，而不是按正文搜。搜 `high`/`quest` 这类词会命中全部 414 页 |
| `vrchat_kb_list` | 报告已加载的库、页数、分类与可信度分布、draft/deprecated 计数 |
| `vrchat_kb_unity` | Unity 运行时状态：进程、项目归属、编辑器版本、lockfile、**许可证剩余天数**、疑似 MCP 端口 |
| `vrchat_kb_scan` | 扫描产出代码的硬约束违例。**是报告不是判决** |

设计上的两条硬约束：

1. **失败分支必须给 `null` 而不是 `undefined`。** `dsh-tools` 在 `render` 前用
   `snapshotJsonValue` 校验，含 `undefined` 属性会让整个调用变成 `INVALID_TOOL_OUTPUT`，
   模型看到的是一行错误码而不是工具认真写好的说明。
2. **路径只接受库内相对路径。** 传安装路径、绝对路径、`../` 一律拒绝，否则「引用出处」
   会变成「暴露本机目录结构」。

---

## 5. 检索设计的三条硬性要求

1. **准入必须"关于"，不能"提及"。** 词法重合不等于主题相同：讲网格简化的页面里写着
   "计算流水线"，不能用来回答 Rust CI 问题。准入 = 话题路由命中 ∪ 标题/标签命中 ∪
   单 token 全覆盖；只有正文命中不算。
2. **高频词不单独成事。** `udon` 56%、`同步` 48%、`quest` 37% —— 它们是主题词但无区分度，
   必须与低频词同时出现。判据是 `MIN_COVERAGE 0.5` + `MAX_DISCRIMINATING_DF 0.25`。
3. **ASCII 必须整词匹配。** 子串匹配让 `rust` 命中 `Trust Rank` —— 这就是一个外部问题
   曾经"找到" 25 个页面的原因。

满足这三条之后，库外问题才会真正返回空结果，**覆盖边界回落**才有意义：告诉模型
「这是库的边界，不是你检索不够」，从而止住反复查询。

---

## 6. 包布局（当前实际）

```
D:\新建文件夹 (2)\
├── VRChat-Agent-Creator-Library/          ← submodule：语料本体，只读
├── vendor/
│   ├── vrchat-world-codex-skills/         ← submodule：技能包（入口 + 3 子技能）
│   └── vrchat-editor-skill/               ← submodule：技能包（Avatar 审计）
├── content-src/                           ← 手写策展源（人改这里）
│   ├── persona-prefix.md, t0-core.md
│   ├── t1-{world,avatar,shader}.md
│   └── domain-map.md
├── data/                                  ← 构建产物，随包分发（gitignore）
│   ├── manifest.json                      ← 上游版本 / 页数 / 构建时间 / token 估算
│   ├── t0-core.txt  t1-*.txt  domain-map.txt
│   ├── always-load.txt                    ← 预设模式主体
│   ├── persona-prefix.txt / persona-suffix.txt
│   ├── index.json                         ← 414 页元数据，**无正文**
│   ├── api-table.json                     ← 80 类型 / 1253 成员
│   └── keyword-routes.json                ← 上游 index.md 的话题→目录路由
├── lib/                                   ← 7 个模块（见下）
├── tools/                                 ← 构建脚本 + 60+ 个自检
├── index.js                               ← apply(ctx, config)
├── cordis.patch.yml                       ← 生成物
└── preset-plugins.json                    ← 生成物（gitignore）
```

**lib/ 的真实构成**（v0.2 文档里列的 `content/blocks/inject/agentScope/gate/tool` 七件
从未存在过 —— 全部逻辑收在一个 `index.js` 里）：

| 模块 | 职责 |
|---|---|
| `search.js` | 索引、打分、覆盖率门槛、惰性读正文 |
| `docs.js` | 路径解析、按行读、grep、失败形状 |
| `metadata.js` | YAML frontmatter 筛选（`filter` / `list` 工具的后端） |
| `api-table.js` | 已暴露成员表 |
| `lint.js` | 26 条机械可判定的扫描规则 |
| `ledger.js` | 轮次 + 代（generation）作用域的查询台账 |
| `unity-status.js` | 进程 / 项目 / lockfile / 许可证判定 |

**自包含策略**：`data/` 与语料 submodule 都随包分发 → 路径无关、启动即用、零网络依赖。
运行期**不读工作区**，插件的语料根从**包自身位置**推导，不绑 cwd。

---

## 7. 预设：21 行是从哪来的

**Agent preset 没有任何继承机制。** `dsh-agent-preset` 的 Config 只有
`{id, name, description, order, plugins}`，`register()` 原样存下。所以想要完整编码能力的
预设必须**自己声明完整插件列表** —— 官方 `av-evasion` 预设就是这么手写 16 行的。

手抄会漂移，所以 `tools/build-preset-plugins.mjs` 在构建时：

1. 定位**已安装的** `standard.patch.yml`（从运行中的 `DSH Desktop.exe` 推导安装根，
   再逐个尝试其它锚点；**不硬编码路径**）；
2. 读出它的 19 个顶层行；
3. 把 `persona` 就地替换成我们的（保留 id，位置不变）；
4. 追加 `vrchat-kb-preset` 与 `vrchat-skills`；
5. 把 `tool-skill` 的 `catalogDescriptionMaxLength` 设为 1024（仅本预设）；
6. 断言「提供者 + 读取通道」成对存在 —— 只有 provider 没有 reader，
   技能文件存在于磁盘但没有任何列表会提到它们，也没有任何东西能加载它们。

两条 `!!js` 表达式必须原样保留（`tool-bash` / `tool-pwsh` 的平台门控，以及两个技能目录）。
JSON 往返会把 tag 退化成字符串，而 `disabled: "process.platform === 'win32'"` 是真值 ——
**两条 shell 会被同时禁用**，症状只是「agent 不能执行命令」。

---

## 8. 技能：两套，原样引入

| 根 | 内容 | 管什么 |
|---|---|---|
| `vendor/vrchat-world-codex-skills/` | 入口 `vrchat-world` + 3 子技能 | World / Udon 的设计—实施—核验 |
| `vendor/vrchat-editor-skill/` | `inspect-vrchat-avatar-project` | Avatar 的检查/审计 + 三份 provider 手册 |

**分工：知识库管事实，技能管流程。** 参数多少、API 是否暴露、组件语义查库；
「改这个之前先建什么责任矩阵、按什么顺序查、过哪张验收表」走技能。
语料里的 `entities/avatar/avatar-audit-methodology.md` 是编辑器技能的中文本地化压缩版，
**只作速查**；两者冲突以技能为准。这条写进了 order 640 的注入段 —— 不写的话模型读完那页
（它自称「本库 Avatar 检查/审计的唯一入口文档」）就再也不会加载技能。

三个实现细节：

- **`includeDefaultRoots: false`。** 我们的 `vrchat-skills` 实例只服务两个 vendor 根。
  默认值是 `true`，会连 `~/.agents/skills`、`DSH_HOME/skills`、项目根一起扫 —— 而
  `standard` 的 `skill-filesystem` 行本来就在管那些。两个 provider 各返回一套，
  registry 按 rank 去重并留下 `higher-priority skill already exists` 警告，白扫两遍。
- **catalog 上限 1024。** catalogue 每行是 `- \`name\`: description`，默认截断在 500，
  而这一行是模型**唯一**的路由依据。编辑器技能的描述是 795 字符，最后一句正是
  「Do not use for VRChat World or Udon projects」—— 在 500 处刚好被砍掉，
  于是它会去抢 World 请求。改配置而不是改上游文件，因此**不需要 fork**。
- **「必须 Unity MCP」是标注义务，不是安装义务。** 未连上编辑器时照常做静态取证，
  但结论必须标 `STATIC_SOURCE` / `MCP_REQUIRED` / `BLOCKED`，不许升格、不许写 `PASS`。
  装不装桥、走 CLI 还是 batch-mode 由使用者按条件决定。

> 预设里**没有** `mcp-client` 行。现有的是 `vrchat_kb_unity`（只读进程/许可证探测）
> 加 shell 与 fs。能装桥、能配置、能查状态，但连不上编辑器。

---

## 9. 已实测确认的 Host 事实

| # | 事实 | 影响 |
|---|---|---|
| 1 | 同名 scoped section **shadow** 全局 section | 两行共用 section 名 `vrchat-kb`，恰好一条生效 |
| 2 | section 只能 **append**；`PromptSection.complete: true` 才是整体替换 | 我们绝不用 `complete` |
| 3 | `AssembleContext` 只有 `{scope?, signal?}`，**拿不到 agent 也拿不到本轮 messages** | 由此推出：按轮条件注入做不了 —— 见 §11 |
| 4 | 工具同名时 scoped shadow 全局；`deferLoading` 只是 provider 侧提示，不是删除 | 工具不门控是安全的 |
| 5 | `tokenMeter.measure(session)` 可做真实计量；`/vrchat` 的 `cost` 子命令在跑 | 台账里的估算值可被实测校验 |
| 6 | 会话日志是多帧 zstd；整体解压只出第一帧 | 分析历史会话要按 magic 切帧 |
| 7 | `fs.cpSync` 在 Node v24.9.0 + Windows 上会 `0xC0000409` 崩进程 | 所有复制都走别的方式 |

---

## 10. 验收：哪些测了、哪些没测

**已测（文件面与配置面）**：60+ 个自检脚本覆盖 schema 编译、输出形状、路径契约、
行号契约、元数据筛选、lint 规则、许可证判定、幂等性、注入重复率、补丁解析、
技能发现、catalog 渲染。

**未测（行为面）**：**预设从未在任何会话中被选中过。** 截至审计时，1092 个会话记录里
没有一条带 VRChat 预设痕迹，本会话跑的是 `tier: lite`。所以「选了预设之后模型眼前
究竟出现什么」仍是推断，不是观测。

这就是 `docs/preset-selftest.md` 存在的原因：它列出该看到什么，供一次实跑后逐条核对。
**行为面跑一次，胜过文件面一百次断言。**

---

## 11. 与 v0.2 设计的三处分歧（留档）

原设计有一条主线：**用 `agent/pre-step` 在每轮插入 T1 域块，用 `tools/post-execute` 封口
并同轮去重**。实测后放弃，理由如下。

**① 按轮条件注入做不了（依据 §9 #3）。**
`systemPrompt.section` 的 provider 看不见 agent、看不见本轮输入。
要做只能走 `agent/pre-step` 手工改 `messages` —— 那是在别人的对话结构里塞内容，
每轮都要展开并重建 `PreStepDecision`，漏掉 `startsRequestSeries` 之类的字段就会出
难以定位的问题。收益是「无关会话省 700 tok」，成本是一条常驻的手改流水线。

**② 词表门控的必要性消失了。**
门控的前提是「默认模式也要注入一点」。但实际选择是**默认模式零注入**：没选预设的会话
连 T0 都不给。于是没有需要门控的东西 —— 选了预设就该拿全量，这是用户的显式选择。

**③ 封口与同轮去重换了载体。**
原设计要在 `post-execute` 拦截结果替换内容。实际做法是 `lib/ledger.js`：轮次 + 代作用域的
台账，重复查询由工具自己回答「已经查过」并附上刚才的结果。

两条正确性规则值得记住：

- **作用域是「轮」不是「会话」也不是「步」。** 跨轮说「你问过了」是噪音，因为模型看不见了；
  而「步」太窄，一轮跨多步，步与步之间重复问正是要省的。
- **compaction 让记忆失效。** compaction 用 `surfaceOp: replace` 换掉消息跨度，先前的
  摘录已经不在模型可见范围内了。此时回答「已经查过」等于递给它一个无法核实的断言。
  所以台账在 `compaction/start` 时 bump 代，旧查询只在同一代内计数。

---

## 12. 已知边界

- 检索是**词法的**（bigram + 文档频率），没有向量。同义改写（"角色" vs "Avatar"）靠
  `keyword-routes.json` 的别名兜底，不靠语义。
- 上游更新后需重跑 `node tools/build-knowledge.mjs`；`content-src/` 是手写策展，
  不会自动跟随上游变化。
- 语料内部存在**已知的自相矛盾**（Quest 档位表两套、带宽两套、SphereCast 两说、
  Unity Constraints 两说、Quest Shader 白名单两说）。persona 的取值已选边并就近标注，
  但没有「persona 数值 ↔ 语料具体行」的一致性守卫 —— 换数字不会有人拦。
- `pi-ai` 路由不支持 `deferLoading`（本插件未使用该标志）。
