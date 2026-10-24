---
name: vrc-get-cli
description: |-
  VPM（VRChat Package Manager）的命令行客户端，也是 ALCOM 图形界面背后的同一套引擎。
  用于在 Unity 工程里安装 / 移除 / 升级 VPM 包、管理本机包仓库、查询已安装与可升级的包、
  以及把旧的 unitypackage 工程迁移到 VPM。当任务涉及 Packages/manifest.json、VPM 包名、
  VCC / ALCOM 的仓库列表，或需要在没有图形界面的情况下改动工程依赖时使用。
  不适用：Udon / Shader 代码编写、Unity 编辑器内的场景操作、或只有 GUI 才能完成的事。
agent_created: true
---

# vrc-get —— VPM 的命令行客户端

**本技能依据 vrc-get v1.9.3 编写**：GitHub `vrc-get/vrc-get`，tag `v1.9.3` → commit `24c4d86`。
2026-10-24 用真实二进制逐条核对 `--help`，并用源码核对路径与语义。

上游很活跃，命令集会变。**参数一律以 `vrc-get <cmd> --help` 的实际输出为准**，本文只记语义与坑。

## 它是什么，不是什么

```
vrc-get       ← CLI，VPM 的权威实现（Rust，MPL-2.0）
vrc-get-gui   ← 同仓库子目录，产品名叫 ALCOM
```

**ALCOM 不是独立客户端，它就是这个工具的画皮。** 所以：

- 「给 ALCOM 加个仓库」「让 ALCOM 装这个包」→ 直接用 CLI 做，**不需要 GUI 在场**
- 写完 CLI 之后 GUI 刷新即见，因为两者读写同一份配置

配置根（源码 `vrc-get-vpm/src/io/tokio.rs` 里写死）：

```
%LOCALAPPDATA%\VRChatCreatorCompanion\
  settings.json     ← 仓库列表、工程列表、Unity 路径（VCC / ALCOM / vrc-get 共用）
  Repos\            ← 仓库缓存
  vrc-get\          ← vrc-get 自己的缓存
```

## 定位与安装

```powershell
where.exe vrc-get                     # 先看有没有
winget install anatawa12.vrc-get      # Windows（包 ID 仍是旧 org 名）
```

其他渠道：`cargo install vrc-get`、`cargo binstall vrc-get`、scoop、brew、AUR，或从
[releases](https://github.com/vrc-get/vrc-get/releases/latest) 直接下静态二进制。

**装完要新开进程**，PATH 才算生效。找不到就直接说没装，不要假装能跑。

## 该走哪条路

| 用户要什么 | 跑什么 | 细节 |
|---|---|---|
| 给工程装一个包 | `vrc-get install <id> [version]` | [install-and-upgrade](references/install-and-upgrade.md) |
| 升级已有的包 | `vrc-get upgrade [name] [version]` | 同上（**与 install 语义不同**） |
| 把依赖装回 lock 状态 | `vrc-get resolve` | 同上 |
| 移除包 | `vrc-get remove <name>...` | 同上 |
| 看哪些包能升 | `vrc-get outdated` | [inspect](references/inspect.md) |
| 加/删/看仓库 | `vrc-get repo ...` | [repositories](references/repositories.md) |
| 查工程当前状态 | `vrc-get info project` | [inspect](references/inspect.md) |
| 把旧工程迁到 VPM | `vrc-get migrate ...` | [migrate](references/migrate.md) |

## 三条最容易踩的

**1. `install` 会写 `dependencies`，`upgrade` 不会。** 源码注释专门强调这一点：

> With install command, you'll add to dependencies. With upgrade command, you'll upgrade
> dependencies or locked dependencies **but not add to dependencies**.

要新装一个包必须用 `install`；用 `upgrade` 装不进去，而且它**不报错**。

**2. `search` 查的是「本机已添加的仓库」，不是全网。**

```
repo list 为空  →  search 什么都搜不到
```

那不是「没这个包」，是「没配仓库」。先 `repo list` 确认，再谈搜不到。

**3. 只有 `outdated` 和 `info` 支持 `--json-format`，且只接受 `1`。**

```
vrc-get outdated --json-format 1
vrc-get info project --json-format 1
vrc-get info package <name> --json-format 1
```

源码里是 `supported @ 1..=1`，传 `2` 直接 `unsupported json version: 2` 退出。
**其余命令没有 JSON**，只能解析人类可读文本——不要对其他命令乱试 `--json`。

## 通用行为

- 所有工程相关命令都有 `-p, --project <PATH>`，**默认取 CWD 或它的父目录**。
  所以不需要先 `cd` 进工程。
- `--offline` 只用本地缓存、**隐含 `--no-update`**；`--no-update` 单独用则只跳过刷新。
- 会写盘的命令大多有 `-y, --yes` 跳过确认。**自动执行时给 `-y`，否则会卡在交互提示上。**
- 出错返回 `exit 1` 并打到 stderr，例如工程路径不对时：

  ```
  w: Packages directory not found
  error loading unity project: Error opening ProjectVersion.txt: ...
  ```

  它**不会创建任何东西**，可以安全地拿它试探路径对不对。

## 不要用通用知识替代它

VPM 的解析规则（包版本、lock、仓库优先级）有明确语义，别用 `npm` / `pip` 的经验套。
拿不准就跑 `vrc-get info` 看现状，或读本文的 references，不要猜。
