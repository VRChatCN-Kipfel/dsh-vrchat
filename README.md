# dsh-vrchat

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 VRChat 创作者工具链。

**一次装好，你的 agent 就知道 Udon 的坑在哪、Quest 的线在哪、这个 SDK 包到底能不能用** ——
而不是先编一个看起来合理的答案。

- **414 页** VRChat 知识库，随包分发，离线可用
- **9 个工具**：查概念 / 定位行号 / 按元数据筛 / 查 Udon API 是否暴露 / 扫代码违例 / 探本机 Unity / **从零建工程**
- **6 个技能**：World 设计-实施-核验流程、Avatar 审计流程、VPM 命令行、外部技能推荐表

---

## 30 秒上手

```bash
# 1. 装进当前 profile（Web GUI 也可以从插件面板装）
dsh plugin --profile web add github:VRChatCN-Kipfel/dsh-vrchat

# 2. 重启 DSH Desktop
```

然后在会话里**选用 `vrchat` 预设**。没选预设时插件也在工作，只是不注入专家人设：

| 你选了什么 | 发生什么 |
|---|---|
| 什么都不选（`tier: lite`） | 9 个工具可用，**不占用任何 prompt 字符** |
| 选 `vrchat` 预设（`tier: preset`） | 额外注入红线、覆盖地图、World/Avatar/Shader 全量域块（约 24,800 字符） |

试一句：

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
| `vrchat_kb_filter` | 按 `type` / `category` / `confidence` / `tags` 筛页 |
| `vrchat_kb_list` | 看库的整体构成 |

### 查你的机器与代码

| 工具 | 什么时候用 |
|---|---|
| `vrchat_kb_unity` | Unity 装没装、许可证还剩几天、有没有 MCP 桥在跑（**只读**） |
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

> ALCOM 的「建工程」只存在于 GUI 进程内部，`vrc-get` 没有创建子命令 ——
> 所以此前 agent 无法自己开工程。这个工具补的就是这一步。
> 它**不伪造** `ProjectSettings.asset` / `InputManager.asset`（Unity 首次打开时生成）。

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

技能目录里每条描述是模型**唯一**的路由依据。本预设把它从默认 500 字符调到 1024，
因为编辑器技能的描述有 795 字符，最后一句正是「Do not use for VRChat World or Udon projects」——
在 500 处被砍掉，它就会去抢 World 请求。

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

`data/` 只放**能从语料机械推导的东西**；正文永远留在 submodule 里。

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
