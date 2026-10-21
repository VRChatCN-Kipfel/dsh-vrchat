# dsh-vrchat-kb

VRChat 创作知识库插件：**红线主动注入 + 专用查询工具**。

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
| 默认 | 任意会话 | 红线 + 领域识别 + 回答纪律 | ~550–810 tok |
| VRChat 创作预设 | 选用 `vrchat` 预设 | 红线 + 覆盖地图 + World/Avatar/Shader 全量域块 | ~2650–3840 tok |

预设行与全局行注册**同名** `vrchat-kb` section，作用域内的会 shadow 掉全局那条 —— 恰好一条，无重复。
因此预设必须自带红线（不能继承全局的）。

## 数据

`data/` 是**构建产物，随包分发**，运行期不读工作区、不联网：

| 文件 | 内容 |
|---|---|
| `t0-core.txt` | 红线注入块（手写策展） |
| `t1-{world,avatar,shader}.txt` | 域块（手写策展） |
| `domain-map.txt` | 覆盖地图 + 不覆盖声明 |
| `always-load.txt` | 预设模式主体 |
| `index.json` | 414 页元数据 + 上游 `confidence` |
| `pages.json` | 414 页全文（~3.8 MB，长尾检索用） |
| `keyword-routes.json` | 上游 `index.md` 的话题→目录路由表（20 条，解析自 `## 搜索关键词`） |

## 重建

```bash
node tools/build-knowledge.mjs     # 上游 submodule → data/
node tools/estimate-tokens.cjs     # CJK/ASCII 分开的 token 估算
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
