# **DSH-VRChat**

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 VRChat 创作者工具链。

**一次装好，你的 agent 就知道 Udon 的坑在哪、Quest 的线在哪、这个 SDK 包到底能不能用** ——
而不是先编一个看起来合理的答案。

- **414 页** VRChat 知识库，随包分发，离线可用
- **9 个工具**：查概念 / 定位行号 / 按元数据筛 / 查 Udon API 是否暴露 / 扫代码违例 / 探本机 Unity / **从零建工程**
- **6 个技能**：World 设计-实施-核验流程、Avatar 审计流程、VPM 命令行、外部技能推荐表

---

## 30 秒上手

### 先确认前置条件

安装过程会**从 GitHub 拉三个上游仓库**（语料与两套技能），所以需要：

| 需要 | 为什么 |
|---|---|
| **git 在 PATH 上** | 三个上游仓库要 clone；没有 git 装不上 |
| **能访问 github.com** | 同上；离线环境装不了，会明确报错而不是装个残缺的 |
| **Node.js 18+** | 安装钩子要跑构建（DSH 自带 node，通常无需另装） |

装的时候会花 **40 秒到 1 分钟**，主要时间在拉语料。这不是卡住。

### 装

```bash
dsh plugin --profile web add github:VRChatCN-Kipfel/dsh-vrchat
```

Web GUI 也可以从**插件面板**装。装完**重启 DSH Desktop**。

### 启用专家人设

插件装好后自动生效（9 个工具随时可用），但要激活「VRChat 专家」这套人设，需要在会话里
把预设切到 **「VRChat 创作模式」** —— 在会话顶部的预设选择器里选，或新建会话时选它。

| 你的状态 | 能力 |
|---|---|
| 没选预设 | 9 个工具可用，**不占用任何 prompt 字符** |
| 选了「VRChat 创作模式」 | 额外注入红线、覆盖地图、World/Avatar/Shader 全量域块（**两万多字符**，每轮都付） |

### 装完自检

不确定装好没有，在会话里输入：

```
/vrchat stats
```

它会打印本会话实际注入了多少字符、知识库版本、语料页数。**能看到这些数字就是装好了。**
如果它报「data/ 不完整」，说明安装钩子没跑成功，先卸载重装（见下方排查）。

### 试一句

> 我在 Blender 里改了形态键，Unity 里模型不显示

它会检索到 `blender-shape-keys.md` 并给出 FBX 导出/导入的具体设置，而不是泛泛地说「检查导入设置」。

---

## 它能做什么

### 查

| 工具 | 什么时候用 |
|---|---|
| `vrchat_kb` | 问一个概念：同步变量怎么设计、PhysBone 上限多少、Poiyomi Quest 用哪个变体 |
| `vrchat_kb_grep` | 知道确切符号，要行号定位 |
| `vrchat_kb_read` | 拿到行号后读上下文 |
| `vrchat_kb_api` | **这个 API 在 Udon 里到底能不能用**（三态：已暴露 / 类型已知但未列 / 无数据） |
| `vrchat_kb_filter` | 按 `type` / `category` / `confidence` / **`status`** / `tags` 筛页 |
| `vrchat_kb_list` | 看库的整体构成 |

### 查你的机器与代码

| 工具 | 什么时候用 |
|---|---|
| `vrchat_kb_unity` | **正在运行的** Unity / Unity Hub / MCP 桥进程、以及从它们启动参数里读到的许可证状态（**只读**） |
| `vrchat_kb_scan` | 写完 `.cs` / `.shader` 后扫一遍硬约束违例（只报告，不阻断） |

### 动手

| 工具 | 什么时候用 |
|---|---|
| `vrchat_kb_project_new` | 用户说「给我做个世界」，而他手上没有工程 |

`vrchat_kb_project_new` 写的是 vrc-get-gui 自己用的 `Blank` 模板形态：三个目录 +
`ProjectVersion.txt` + 两个包清单。**不联网、不启动 Unity、不装 SDK**，SDK 由下一步补：

```bash
vrc-get resolve -p "<刚建的工程>"
```

参数（都有兜底，沿用你的默认判断）：

| 参数 | 说明 |
|---|---|
| `targetDir` | 必填。父目录必须已存在 |
| `type` | 必填。`world` 或 `avatar` |
| `unityVersion` | 默认 `2022.3.22f1`（SDK 3.5.0+ 绑定） |
| `force` | 目标已存在时仍要创建。**会先改名为 `<目录>.bak-<时间戳>`，不删除** |
| `dryRun` | 只报告将写什么，不落盘 |

⚠️ `force` 的语义是**备份而不是覆盖**：原目录会被改名留着，你可以随时改回去。

> ALCOM 的「建工程」只存在于 GUI 进程内部，`vrc-get` 没有创建子命令 ——
> 所以此前 agent 无法自己开工程。这个工具补的就是这一步。
> 它**不伪造** `ProjectSettings.asset` / `InputManager.asset`（Unity 首次打开时生成）。

### 斜杠命令：给人看的自查入口

模型不会看到这些输出，它们是**你自己检查插件状态**用的：

| 命令 | 做什么 |
|---|---|
| `/vrchat stats` | 本会话实际注入了多少字符、知识库版本与构建时间、语料页数、本会话已问过哪些问题 |
| `/vrchat stale` | 知识库构建了多久，提醒是否需要重建 |
| `/vrchat scan <路径>` | 提示模型去扫这个路径的 `.cs` / `.shader`（斜杠命令本身不读文件） |

装完不确定成不成，`/vrchat stats` 是第一站 —— 能看到数字就说明插件在工作。

### 输入框上方那行小字

选用预设的会话里，输入框上方会出现一行成本提示，形如 `注入 <N> 字符 · <M> 次查询`。

**这里不写具体数字，因为它每一版都会变** —— 数字会随 persona 一起变，写死就是又一处
文档与实现漂移。想看当前值，用 `/vrchat stats`。

它是**本会话**的实际用量，不是全局统计；子会话的查询会汇总进来（token 不汇总，因为子会话
自己付自己的上下文）。**没选用预设、也没查过库时这行不显示** —— 那样才是对的，
它不该在一个跟 VRChat 无关的会话里占位置。

---

## 随包技能

技能与知识库分工明确：**知识库管事实，技能管流程。**

「参数是多少、API 是否暴露」→ 查库。「改这个之前先建什么责任矩阵、按什么顺序查、过哪张验收表」→ 走技能。

| 技能 | 管什么 |
|---|---|
| `vrchat-world` + 3 个子技能 | World / Udon 的设计—实施—核验流程 |
| `inspect-vrchat-avatar-project` | Avatar 的检查 / 诊断 / 审计 |
| `vrc-get-cli` | VPM 包管理命令行（ALCOM 的底层引擎） |
| — | 外部技能推荐表：`vendor/vrchat-world-codex-skills/docs/RECOMMENDED_OPEN_SOURCE_SKILLS.md` |

技能目录里每条描述是模型**唯一**的路由依据。本预设把它从默认 **500** 字符调到 **1024**。

编辑器技能（`inspect-vrchat-avatar-project`）的描述共 **795** 字符，最后的排除句
「Do not use for VRChat World or Udon projects」落在第 **750** 字符处。默认 500 时，
截断点卡在中段的工具清单上（`…inspect parameters, Animator layers, FaceEmo, l`）——
**被砍掉的不只是那一句，还有它前面半段 provider 名录**。留下的前半段里全是
Animator、参数、预览、构建这类通用 Unity 词，于是它会去抢 World 请求。

调到 1024 之后整句保留，它就能明确说出「不适用于 World」。

---

## 为什么这样分工

导航类内容（文件清单、目录树、索引页）**一旦嵌进 prompt，就抢走了「由查询决定返回什么」的能力**。

所以 agent 不需要知道 `entities/world/udon/persistence/index.md` 存在，只需要知道可以问。

`full` 是 `preset` 的兼容别名（行为完全相同），新配置不要再写 `full`。

---

## 数据从哪来

**语料本体** —— `VRChat-Agent-Creator-Library/`（submodule，414 个裸 Markdown）。
它是插件本体的一部分，**不经 `data/`、不被重新序列化**：查询时按需打开命中的那几页。

**派生数据** —— `data/`（构建产物）

| 文件 | 内容 |
|---|---|
| `t0-core.txt` | 红线注入块（手写策展） |
| `t1-{world,avatar,shader}.txt` | 域块（手写策展） |
| `domain-map.txt` | 覆盖地图 + 不覆盖声明 |
| `always-load.txt` | 预设模式主体 |
| `index.json` | 414 页元数据 + 上游 `confidence`（无正文） |
| `api-table.json` | SDK 3.10.3 已暴露清单（80 类型 / 1253 成员） |
| `keyword-routes.json` | 话题→目录路由表（20 条） |

`data/` 里是**两类**东西，别混：`t0-core` / `t1-*` / `domain-map` 是**手写策展**
（源在 `content-src/`，人改那里，构建时只做格式转换）；`index.json` / `api-table.json` /
`keyword-routes.json` / `manifest.json` 是**从语料机械推导**的。

**正文永远留在 submodule 里**，不进 `data/` —— 查询时按需打开命中的那几页。

---

## 检索设计的三条硬性要求

1. **准入必须「关于」，不能「提及」**。一个讲网格简化的页面里写着「计算流水线」，不能用来回答
   Rust CI 问题。准入 = 话题路由命中 ∪ 标题/标签命中 ∪ 单 token 全覆盖；只有正文命中不算。
2. **高频词不单独成事**。`udon` 56%、`同步` 48%、`quest` 37% —— 主题词但无区分度，必须有低频词同时出现。
3. **ASCII 必须整词匹配**。子串匹配让 `rust` 命中 `Trust Rank`。

满足这三条，库外问题才会真正返回空结果，**覆盖边界回落**才有意义 ——
告诉模型「这是库的边界，不是你检索不够」，从而止住反复查询。

---

## 开发

```bash
node tools/build-knowledge.mjs     # 上游 submodule → data/
node tools/measure-content.mjs .   # CJK/ASCII 分开的 token 估算

node tools/selftest.cjs                             # 数据完整性 + 示例查询
node tools/debug-query.cjs "Udon 同步变量 非 Owner"  # 单条查询的覆盖率与路由
node tools/token-df.cjs rust 同步 quest              # 文档频率
```

改完 `content-src/` 之后必须重跑 `build-knowledge.mjs`，否则安装代里还是旧文本。

### 想了解内部构造

`docs/vrchat-kb-architecture.md` 记录了实现细节：双行 patch 的结构与为什么是两个 tier、
注入分块与各自的 order、检索准入的三条硬性要求及其理由、以及几处**被放弃的设计**
（agent 级门控、tools/post-execute 封印）连同它们失败的原因。

那份文档是写给维护者的，不是使用说明。

---

## 已知边界

- **检索是词法的**（bigram + 文档频率），没有向量。同义改写靠 `keyword-routes.json` 的别名兜底，不靠语义。
- **上游更新后需重跑构建**；`content-src/` 是手写策展，不会自动跟随上游变化。
- 预设里**没有 `mcp-client` 行**：Unity 能力来自 `vrchat_kb_unity`（只读进程/许可证探测）+ shell/fs，
  不是编辑器工具。要接编辑器请自行配 Unity MCP 桥。
- `pi-ai` 路由不支持 `deferLoading`（本插件未使用该标志）。

---

## 许可

MIT。语料来自 [`RhineLab-magellan/VRChat-Agent-Creator-Library`](https://github.com/RhineLab-magellan/VRChat-Agent-Creator-Library)，
两套技能分别来自 `VRChatCN-Kipfel/vrchat-world-codex-skills` 与 `XiaoboooOvO/VRChatEditorSkill`，
均以 submodule 原样引入，许可随各自仓库。
