# VRChat Agent Creator Library → DSH 知识库插件架构（v0.2 · 核心机制已实测验证）

> 状态：**核心机制已验证**（2026-10-21 探针实测，证据见 §8）。正式代码尚未落地。
> 目标：主动注入 · 节省 token · 模型愿意来问。
> 知识源：`VRChat-Agent-Creator-Library/`（git submodule，414 页 / 4023 KB / 约 1.8M tok）

---

## 0. 一句话定义

**把作者人工策展的 `_always-load.md`（15 KB ≈ 10k tok）压缩成可控分层，并给它装上自动触发门。**

这不是一个"检索插件"，是一个**受控注入插件 + 长尾兜底检索**。检索是配角：它的失败模式（模型反复查、永远查不够）正是本项目要消除的东西。

---

## 1. 关键 API 依据（全部来自运行时 inspection，非猜测）

| # | 事实 | 出处 |
|---|---|---|
| 1 | `systemPrompt.section({name, order, text, interpolate?, complete?})` → disposer；**同名的 scoped section 会 shadow 全局 section** | `Service/systemPrompt` |
| 2 | `PromptSection.text` 可以是 `(ctx: AssembleContext) => string`，但 **`AssembleContext` 只有 `{scope?, signal?}` —— 拿不到 agent、也拿不到本轮 messages** | 同上 |
| 3 | `PromptSection.complete: true` 会让"有效 complete section 被还原为唯一 prompt section" | 同上 |
| 4 | `tools.register(ToolDefinition)`；同名 scoped 工具 shadow 全局；`ToolSchema.deferLoading?: true` | `Service/tools` |
| 5 | `agent/pre-step` 是 waterfall：`{agent, messages, turn, step, signal}` → `PreStepDecision`，**可替换进入该步的 messages** | `Event/agent/pre-step` |
| 6 | `agent/created` 是 serial：`{agent, source, signal}` —— 拿到 `agent.ctx` 注册每-agent 行为的正确时机 | `Event/agent/created` |
| 7 | `tools/pre-execute` 可 allow/deny/cancel/ask；`tools/post-execute` 可 accept/replace/enrich/block | `Event/*` |
| 8 | `agent.inject()` **不唤醒** agent；`agent.followup()` 才唤醒 | `practices.md` §29 |
| 9 | **禁止**用 `system-prompt/assemble` 增删文本或工具；加文本走 `section()` | `practices.md` §17 |
| 10 | `agentPresets.composedPreset(ctx)` / `serviceFor(agent, name)` 可查询 agent 所用的 preset | `Service/agentPresets` |
| 11 | `tokenMeter.measure(session, requestHeader?)` 可做真实 token 计量 | `Service/tokenMeter` |
| 12 | `ToolRunContext.deferContext(UserMessage)`、`ToolExecutionSuccess.additionalContexts` 可附带额外上下文 | `Service/tools` types |
| 13 | Agent preset 是 `preset-<id>` 声明行，`config: {id, name, description, order, plugins}`，经 bundle patch 安装 | `editing-cordis-compositions` |
| 14 | 你的 5 个预设（av-evasion 等）**已是** profile `cordis.patch.yml` 内的 `preset-<id>` 行（`# dsh-desktop legacy presets begin` 之后） | 实测 |

### 由 #2 推出的一个硬结论

**按轮条件注入不可能放在 `systemPrompt.section` 里做** —— 它的 provider 看不见 agent，也看不见本轮用户输入。
所以职责必须切开：

- **`systemPrompt.section`** → 只负责**静态/按 agent 固定**的常驻块（T0、预设模式全量块）。
- **`agent/pre-step`** → 唯一能做**按轮词表门控**的地方（它是唯一同时拿到 `messages` 和 `agent` 的注入点）。

这一条决定了整个组件的边界划分。

---

## 2. 组件图

```
┌─ Harness Host 进程 ─────────────────────────────────────────────────────┐
│                                                                         │
│  Bundle: dsh-vrchat-kb                                                  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ cordis.patch.yml                                                  │  │
│  │  insert:                                                          │  │
│  │   ├─ row  vrchat-kb        config:{ tier: lite }  ← 全局常驻层     │  │
│  │   └─ row  preset-vrchat    config:{ plugins:[ ... vrchat-kb       │  │
│  │                                              (tier: full) ... ] } │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Host plugin  apply(ctx, config)                                        │
│  ├── content.js   载入 data/*  ──► 模块级 Map 缓存（两个实例共享）        │
│  ├── search.js    倒排索引 + 打分（无向量库，无 embedding）              │
│  ├── blocks.js    按 tier 选择注入块：t0-core / t1-<domain> / always-load│
│  ├── inject.js    ctx.systemPrompt.section({name:'vrchat-kb', ...})     │
│  ├── agentScope.js agent/created → agent.ctx 上的 per-agent 注册        │
│  ├── gate.js      agent/pre-step  → 词表命中则注入 T1                    │
│  └── tool.js      ctx.tools.register('vrchat_kb')                       │
│                   + ctx.on('tools/post-execute') 封口 / 同轮去重         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 双层实例 + 同名 shadow —— "预设模式"的实现机制

利用依据 #1（**同名 scoped section 会 shadow 全局**），预设模式不需要任何插件内的模式判断：

| | 全局行 `vrchat-kb (tier: lite)` | 预设行 `vrchat-kb (tier: full)` |
|---|---|---|
| 注册位置 | 插件根 context（全局） | preset 的 scope |
| section 名 | `vrchat-kb` | `vrchat-kb` |
| 效果 | 所有会话可见 | **同名，shadow 掉全局那条** |

→ 选中 VRChat 预设的会话得到 full 块；其余会话得到 lite 块。**恰好一条 section，无重复、无需协调。**

两个实例读同一份 `data/`：因为两行加载的是**同一个 JS 模块文件**，一个模块作用域的 `Map` 缓存即可让内容面天然共享，**不需要 service / isolate / realm 那套复杂度**。

---

## 3. 模式矩阵（token 账）

| 层 | 默认模式（任意会话） | 预设模式（选用 VRChat preset） |
|---|---|---|
| **T0 常驻** | ✅ ~700 tok，无条件 | ✅（合并进 full 块） |
| **T1 域块** | 🔶 词表命中才注入，~1.5–2.5k tok | ✅ 已 opt-in，直接并入 |
| **`_always-load` 主体** | ❌ 不注入 | ✅ 压缩后注入 ~7k tok |
| **检索工具** | ✅ 常驻可用 | ✅ 常驻可用 |
| **起始成本** | 无关会话 **~700 tok**；命中 **~2.7k tok** | **~8–10k tok** |
| **门控** | 词表门控开启 | 关闭（用户已显式选择） |

占典型上下文比例：默认 0.35% / 命中 1.4% / 预设 5%。

---

## 4. 四条运行时数据流

### 流 A — 常驻注入（每轮，零判断）
```
assemble 前  →  inject.js 已注册 section 'vrchat-kb'
             →  text = data/t0-core.md（~700 tok：10 条红线 + 领域识别树 + 工具 when-to-use）
```
无条件、无逻辑、不依赖任何时机。这是"消灭未知的未知"的成本，固定 700 tok。

### 流 B — 词表门控（每轮，仅默认模式）
```
agent/pre-step(payload)  ── waterfall，必须 return next() 并展开 decision
  ├─ await next()                            ← 先拿原始 decision（不要吞掉别人的）
  ├─ 判定 payload.messages 是否命中词表
  │    中文槽: 虚拟形象/改模/世界/材质/同步/参数/上传
  │    英文槽: vrchat|udon|udonsharp|avatar|physbone|poiyomi|liltoon|
  │            vrcfury|modular.?avatar|quest|android|osc|vpm|vcc|alcom
  │    排除槽: 已是 VRChat 无关语境（如纯 Rust/CI 任务）
  ├─ 未命中 → 原样返回 decision（0 额外成本）
  └─ 命中   → return { ...decision, messages: [...decision.messages, t1Block] }
                ↑ 展开 decision，保住 startsRequestSeries 等字段（practices §16）
```
T1 块按命中域选择（World / Avatar / Shader），不是一股脑全给。

### 流 C — 检索（长尾兜底，0 常驻）
```
模型调用 vrchat_kb(query)
  → search.js 倒排索引打分 → 取命中页
  → 合并、去重、按 confidence 排序
  → 返回【答案包】（不是片段包）
```

### 流 D — 封口与同轮去重（专治"反复查找"）
```
tools/post-execute(exec, result)
  ├─ 是 vrchat_kb 的结果？
  │   ├─ 本轮已查过同类 query → 替换为「你已查过，以下是刚才的结果：<缓存>」
  │   └─ 新 query              → 追加封口行 + 范围地图
  └─ 否则 return next()
```

**封口行**（给可判定的停止条件）：
> `以下为本库对该问题的全部相关约束。若无命中即表示本库不覆盖，不要重复检索。`

**范围地图**（空结果时）：
> `未命中。本库覆盖：World(Udon/同步/Persistence/组件) · Avatar(Animator/PhysBone/Shader/优化) · API · Platform(Quest) · SDK · 设计模式 · 规范红线。不覆盖：<按 query 推断的邻近域列出>。`

---

## 5. 包布局

```
D:\新建文件夹 (2)\
├── VRChat-Agent-Creator-Library/        ← submodule（上游知识源，只读）
├── tools/
│   └── build-knowledge.mjs              ← submodule → data/ 的编译脚本
└── dsh-vrchat-kb/                       ← 可安装 bundle
    ├── package.json                     ← dsh.bundle.patch + meta.title/description + icon
    ├── cordis.patch.yml                 ← Host 插件行 + preset-vrchat 行
    ├── index.js                         ← apply(ctx, config)
    ├── lib/{content,search,blocks,inject,agentScope,gate,tool}.js
    ├── data/                            ← ← 编译产物，随包分发（自包含）
    │   ├── manifest.json                ← 上游 commit、页数、校验和、构建时间
    │   ├── t0-core.md                   ← ~700 tok
    │   ├── t1-world.md / t1-avatar.md / t1-shader.md
    │   ├── always-load.md               ← 压缩后整篇（预设模式）
    │   ├── index.json                   ← 414 页元数据（标题/type/category/confidence/tags）
    │   └── pages.json.gz                ← 全文（检索命中后取用）
    ├── locale/{zh,en}.json
    └── icon.svg
```

**自包含策略**（对应你说的"发包时内带知识库"）：
`data/` 是**编译产物**，随包分发 → 路径无关、启动即用、零网络依赖。
上游更新时跑 `tools/build-knowledge.mjs` 重建 → 新版本包。**运行期不读 submodule**，submodule 只是构建输入，因此插件不绑 cwd。

---

## 6. 内容编译流水线（这是需要你审的部分）

```
_always-load.md (15,011 chars)
   │
   ├─ ① 抽取 L69–137  World 段 ──┐
   ├─ ② 抽取 L141–248 Avatar 段 ─┤
   ├─ ③ 抽取 L195–248 Shader 段 ─┤
   │                             ↓
   │                     去元数据（正则，可逐条审）
   │                       · 删 `⭐NEW 2026-06-15`、`⭐UPDATED …`
   │                       · 删 `→ 详细:xxx`、`→ 详见 xxx`
   │                       · 删 `[[wikilink]]` 包裹只留文本
   │                       · 折叠 `**bold**` 为主文
   │                       · 删 L261–350「文件速查」整表（那是目录，不是约束）
   │                             ↓
   │                     t1-{world,avatar,shader}.md
   │
   └─ ④ 手写策展 t0-core.md（~700 tok）
          · 10 条红线（README L177–188，信息密度最高的 600 字符）
          · 领域识别决策树（L43–50）
          · 工具 when-to-use
```

**人工介入点**：①②③ 的裁剪结果与 ④ 的措辞，全部以可 diff 的 markdown 落盘 → 你可以逐条审、逐条改，改完再编译。这是"先出压缩清单给你审"的落点。

> 注：`_always-load.md` L261–350 那 90 行是「文件速查」目录表（含大量 `⭐NEW`），占全篇相当比例，但**对模型零约束价值** —— 删掉它是最划算的一刀。L353–366 的"更新追加"里混着真约束（Expression 256 bits 配额、第三方工具链兼容性）和一条错位的目录行，需手工拆分。

---

## 7. 预设模式（Bundle 内的第二类行）

```yaml
- insert:
    - id: preset-vrchat
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: vrchat
        name: VRChat 创作模式
        description: VRChat World/Avatar 创作：全量知识注入，Udon/Shader/网络同步红线常驻。
        order: 20
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                你是 VRChat World/Avatar 创作助手……
                Udon VM 硬约束与平台红线已随本会话注入，直接遵守，不要凭常识推断。
          - id: vrchat-kb
            name: '@local/dsh-vrchat-kb'
            config:
              tier: full
```

`persona` 那一行不是装饰：它把"我有一份权威约束"变成模型的**自我认知**，是"愿意来问"的一部分。

---

## 8. 验证结果（2026-10-21 探针实测）

探针 bundle `dsh-vrchat-kb-probe` 已安装运行并卸载。以下每条都有可复现证据。

| # | 结论 | 证据 |
|---|---|---|
| **V1** | ✅ **preset 的 `plugins` 可自引用同一 bundle 内的包** | 模块级 `sharedActivations` 同时记录到 `tier=lite` 与 `tier=full` 两个实例的 `apply()`，时间戳相隔 1 ms（00:29:57.967 / .968）。full 实例由 patch 中 `preset-vrchat-probe` 的 plugins 列表挂载 → **单包方案可行，不必拆两个包** |
| **V1b** | ✅ **同名 scoped section 确实 shadow 全局 section** | 用任务看板以 `mode: vrchat-probe` 起真实会话 `session-46de014e`，解压其日志得 `tier=full -> 1`、`tier=lite -> 0`，样本 `[VRChat-KB-PROBE tier=full]`。**恰好一条，无重复** |
| **注入落地** | ✅ `systemPrompt.section` 真的进系统提示 | 插件安装后新建的 subagent 逐字回报其系统提示含该行；本会话日志 `VRChat-KB-PROBE` 命中 27 次 |
| **V2** | ⚠️ **原结论错误，已更正**（见下方"关于 deferLoading"） | 我原先由"仍在 `Tool/listTools` 中且可直接调用"推断它不省 token —— **该推断不成立**：`listTools` 报的是注册表的可调用目录，与 wire 上的 schema 声明无关 |
| **V3** | ✅ `tools/post-execute` 决策对象可达且可读 | 探针观察到 `{"kind":"accept"}`，`result` 为 frozen 的规范结果。完整契约见 §8.1 |
| **V4** | ✅ `agentPresets.composedPreset(agent.ctx)` 在工具执行时可用 | 返回 `"cordis"`（本会话所用 preset），`agentPresetsPresent: true`，无异常 |
| **V5** | ⏸ 改为规避 | 决定 `data/` 直接产出未压缩 JSON，不用运行时 `node:zlib` 解压，该项作废 |

**关于 `deferLoading`：它是真的，生效与否由路由决定**（源码已确证）

我原来的结论是错的。`deferLoading` 是一条 **provider 级声明**，不是 DSH 本地的隐藏开关。链路三段：

1. **注册表只投影、不隐藏** —— `dsh-tools` 的 `schemaOf()` 把 `deferLoading` 原样带到 model-facing schema 上，工具**始终可调用**。所以"`listTools` 里看得到""我能调用它"这两条证据**无法**用来否定它。我的方法错了。
2. **是否发出去由路由的 `toolUpdate` 能力决定** —— `dsh-llm` 的 `projectToolUpdates()`：
   - `toolUpdate === undefined`（路由不支持）→ **剥掉 `deferLoading`，照常发全量 schema**，此时确实零节省（我原结论**只**在这个分支成立）；
   - `toolUpdate === 'in-history' | 'addition-only'` → 从 `history.tools` 取基线，**会话中途新增的工具被强制标 `deferLoading: true`**，并随 `tool-addition` 开发者消息宣告；
   - **DeepSeek 适配器默认即 `toolUpdate: 'addition-only'`**（`dsh-llm-deepseek/lib/index.js` L47–48）。
3. **落到 API 是 `defer_loading`** —— `dsh-llm-deepseek` 构造请求时对 `deferLoading === true` 的工具发 `defer_loading: true`（同文件 L1711）。所以节省发生在 **provider 侧**，DSH 本地 token 计量看不到差别。

另外一个**会炸**的分支：`dsh-llm-pi-ai` 对任何 `deferLoading` 工具直接抛
`LlmError("Deferred tool loading is not supported yet", "UNSUPPORTED_CONTENT")`。

**对设计的影响**：检索工具应当标 `deferLoading: true`（这正是"中途注册的工具不占 schema 空间"的官方机制），但必须

- (a) 加**路由守卫**：pi-ai 路由下要么不标，要么预期请求直接失败；
- (b) 用**判据 = 请求体里有没有 `defer_loading`** 来验收，而不是 `listTools` 里有没有它。

**探针 2 的实测（12 次 `llm/stream` 观测，本机会话）**——两极同时存在：

| 观测形态 | 次数 | `options.tools` 里探针工具的字段 |
|---|---|---|
| **保留** | 4 | `["deferLoading","description","name","parameters"]` |
| **被剥掉** | 8 | `["description","name","parameters"]` |

- 保留与剥掉**成对紧邻出现**（相隔 3 ms），说明同一步里存在**两种不同的调用**走了不同 `toolUpdate` 能力。
- 两种形态下该工具**都在列表里**（`probe2Present: true`，计数 196/193）—— 再次确认 `deferLoading` **不是删除/去重机制，只是 provider 侧的加载提示**。
- 因此正确表述是：**它是真的杠杆，但是条件性的，取决于路由**；"省 token"发生在 provider 侧，DSH 的 `tokenMeter` 测不出这个差别。

> 附带发现：本机会话单次请求的 `options.tools` 有 **196 个 schema**。工具 schema 才是这份提示词里最大的一块，比 T0 那 700 tok 大两个数量级。K1/K6 的分母应当按实测提示词规模算，而不是按"典型上下文"拍脑袋。

**顺带确证的工具链事实**（都会影响正式实现）：

- 工作区 bundle **不必声明 `peerDependencies`** 也能 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
- `apply(ctx, config)` 里**直接调用** `ctx.tools.register()` / `ctx.systemPrompt.section()` 即可，不必手动 `ctx.effect` 包裹（注册随插件 fiber 自动回收）。
- `defineTool` 的 `parameters` 用 **ParameterSchemaSpec**（每个属性写 `required: true`），投影后得到正确的 JSON Schema；`output.render` 返回 `[{type:"text", text}]`。
- `install_bundle` 以工作区绝对路径为目标：`application: applied`、**无需重启即 HMR 生效** —— 同一步之后模型即可调用新工具。
- 会话日志是**多帧 zstd**（`$DSH_HOME/sessions/<编码cwd>/<session-id>/session.vN.jsonl.zstd`）；整体 `zstdDecompressSync` 只出第一帧，需按 magic 切帧后逐帧解。验证脚本留在 `D:\.cache\dsh-zlog.cjs`。

### 8.1 已确证的 `PostToolDecision` 契约（封口 / 同轮去重的确切 API）

源码：`@deepseek-ai/dsh-tools/lib/index.js` 的 `postExecute()`。

```ts
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: JsonValue; additionalContexts?: UserMessage[] }
  | { kind: 'block';  feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

规则（由实现直接读出）：

- 没有监听器时的默认值是 `{ kind: 'accept' }`。
- `accept` 保持调用成功；给 `content` 即替换内容；给 `value` 会走该工具的 `output.render` 重新渲染。**`content` 与 `value` 不能同时给**（抛 `TypeError`），且**失败结果不能替换 value**。
- `block` 把调用变成 `isError`，内容用 `feedback`。
- 两种决策都可挂 `additionalContexts`，会被 ferry 到结果上。
- 工具体内 `deferContext()` 延后的上下文，`accept` 时保留、`block` 时丢弃。

→ 流 D 的封口/去重：追加说明用 `{kind:'accept', content:[...]}`；对重复查询直接掐断用 `{kind:'block', feedback:[...]}`。

---

## 9. 风险与回落

| 风险 | 缓解 |
|---|---|
| 词表漏触发 → 红线不出现 | T0 是**无条件常驻**，红线永不依赖门控；门控只影响 T1 域块 |
| 注入内容被 compaction 吃掉 | 走 `agent/pre-step` 每轮重注，而非一次性注入 |
| 模型仍反复检索 | 流 D（封口 + 范围地图 + 同轮去重）三层拦截 |
| 上游知识库更新 | `manifest.json` 记上游 commit；重建脚本一条命令 |
| 15 KB 压缩后失真 | 压缩规则可 diff、可逐条审；保留 `always-load.raw.md` 作对照 |
| 误伤无关会话 | T0 仅 700 tok；T1/T2 全靠门控 |

---

## 10. 验收（可测，非主观）

| 指标 | 判据 | 测法 |
|---|---|---|
| K1 常驻成本 | 无关会话 ≤ 总上下文 0.5% | `tokenMeter.measure()` |
| K2 零污染 | 纯 Rust/CI 会话注入字节 = T0 单块 | 同上 |
| K3 触发率 | 20 题 VRChat 真实问题集，T1 词表命中 ≥ 18/20 | 跑题集 |
| K4 **纠错率** | 同一批必触发红线的 prompt，有无插件 A/B，`List<T>`/`async`/URP 等错误输出消失 | A/B 对照 |
| K5 检索收敛 | 单轮 `vrchat_kb` 调用次数中位数 ≤ 1 | 读 session log |
| K6 预设模式总量 | 起始注入落在 8–10k | `tokenMeter.measure()` |

K4 是唯一真正重要的指标 —— 其余都是它的约束条件。
