# 查看现状：info / outdated / search

这三个命令回答「现在是什么状态」，全部只读。

## 唯一支持 JSON 的两个

```
vrc-get info project   --json-format 1
vrc-get info package <name> --json-format 1
vrc-get outdated       --json-format 1
```

**参数值必须是 `1`。** 源码是 `supported @ 1..=1`，其它值会直接：

```
unsupported json version: 2
```

并退出。除了这三个，**其余命令没有 JSON 输出**，不要对它们试 `--json` 或 `--json-format`。

## info project

```powershell
vrc-get info project -p "E:\MyProject"                    # 人类可读，打到 stderr
vrc-get info project -p "E:\MyProject" --json-format 1    # JSON，打到 stdout
```

人类可读形态会给出：

```
Project at <路径>
Using unity <版本>

Locked Packages:          ← packages-lock.json 里的
  <pkg> version <锁定版本> with installed version <已装版本>
  <pkg> version <锁定版本> not installed

Not Locked but installed Packages:   ← 装了但没锁的
  <pkg> version <已装版本>
```

**注意输出去向**：人类可读部分走 **stderr**，JSON 走 **stdout**。
所以想用管道拿结构化结果，必须走 `--json-format 1`；把人类可读版重定向进文件会拿到空。

### 三个状态要分清

| 现象 | 含义 |
|---|---|
| `locked + installed` | 正常 |
| `locked + not installed` | lock 里有，磁盘上没有 → `vrc-get resolve` 能补齐 |
| `not locked but installed` | 磁盘上有，lock 里没有 → 通常是手动放进 `Packages/` 的本地包 |

第三种很常见：用户把包目录直接丢进 `Packages/`，它不是 VPM 管理的，`upgrade` 动不了它。

## info package

```powershell
vrc-get info package com.vrchat.worlds --json-format 1
```

注意它是**顶层 `info` 的子命令，不是在工程上下文里跑的** — 它不接受 `-p/--project`。

## outdated

```powershell
vrc-get outdated -p "E:\MyProject"
vrc-get outdated -p "E:\MyProject" --json-format 1
vrc-get outdated --prerelease          # 把预发布也算进「可升级」
```

人类可读输出形如：

```
<name>: installed: <已装版本>, found: <可用版本>
```

**不代表能升。** `outdated` 只比较版本号，不判断目标版本是否兼容当前 Unity / SDK。
真正升级之前看 `info package` 或该包的发布说明。

## search

```powershell
vrc-get search liltoon
vrc-get search shader toon          # 多个词是 AND 关系的子串匹配
vrc-get search liltoon --offline    # 只用本地缓存，不联网
```

匹配范围：包的 `name`、`displayName`、`description`。

**它只在「本机已添加的仓库」里搜。** `repo list` 为空时必然无结果——那说明没配仓库，
不是没有这个包。见 [repositories](repositories.md) 的排查顺序。

`search` 没有 `--project`，也没有 JSON。

## 只读，可以放心试

这三个命令都不写工程、不改配置。拿不准当前状态时，先跑 `info project` 再决定做什么，
比凭印象直接 `install` / `remove` 便宜得多。
