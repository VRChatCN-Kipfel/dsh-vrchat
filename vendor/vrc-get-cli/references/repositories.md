# 仓库管理：repo list / add / remove / packages / import / export / cleanup

VPM 的包不是从一个中央服务器来的，而是从**本机已添加的一组仓库**来的。
所以「搜不到包」几乎总是「没加仓库」，不是「没有这个包」。

## 先理解这条链路

```
repo add <url>          → 写进 %LOCALAPPDATA%\VRChatCreatorCompanion\settings.json
                        → 同时把仓库清单缓存到 …\Repos\
search / install        → 只在这批已添加的仓库里找
```

`settings.json` 是与 **VCC / ALCOM 完全共用**的同一份文件。
在 CLI 里加的仓库，GUI 刷新就能看到；反之亦然。

## 命令

```powershell
vrc-get repo list                      # 当前有哪些仓库（空 = 一个都没加）
vrc-get repo add <URL> [NAME]          # 加一个远程或本地仓库
vrc-get repo add <URL> -H "k: v"       # 带自定义头（私有仓库鉴权用）
vrc-get repo remove <URL|name|path>    # 按 URL / 名称 / 路径删
vrc-get repo packages <NAME|URL>       # 列出该仓库里有哪些包
vrc-get repo import <repositories.json>  # 批量导入（VCC 导出的列表文件）
vrc-get repo export                    # 导出成列表文件（打印到 stdout）
vrc-get repo cleanup                   # 清理 Repos 目录里的坏条目
```

## 判定顺序（搜不到包时按这个排查）

```
1. vrc-get repo list
     └─ 空 → 没加仓库。这就是原因，不要再往下猜。
2. repo list 有内容，但没目标包
     └─ vrc-get repo packages <那个仓库>   → 确认该仓库里到底有没有
3. 仓库里也没有
     └─ 这个包不是来自 VPM，可能是 GitHub / BOOTH / unitypackage 分发
         → 走别的路径，不要硬塞进 VPM
```

**`search` 只搜本机已添加仓库**，这一点与「网上搜包」是两件事。

## repo add 的两种形态

**远程**：给一个 `https://…/index.json` 形式的仓库地址。

**本地**：给一个**本机目录路径**，用于自己开发的包。

```powershell
vrc-get repo add "E:\MyVpmPackages" "Local Dev"
```

## 关于 repo cleanup

源码里的说明：

> The official VPM CLI will add `<uuid>.json` in the Repos directory even if error occurs.

也就是说 VCC 那边可能留下**失败但残存的缓存条目**。`cleanup` 专门清这个。
仓库列表看起来正常但行为诡异时，跑一次 `repo cleanup` 是安全的低风险动作。

## 私有仓库

`repo add` 支持 `-H, --header`（可重复），用于带 `Authorization` 之类的头：

```powershell
vrc-get repo add https://example.com/index.json "Private" -H "Authorization: Bearer <token>"
```

⚠️ **不要把 token 写进可提交的文件、日志或对话里。** 如果用户把 token 给了你，
只在这一条命令里用掉，不要回显。

## 导出/导入

`repo export` 把当前仓库列表打到 **stdout**（不是写文件），需要自己重定向：

```powershell
vrc-get repo export > repositories.json
```

`repo import` 从文件批量添加，`-y` 跳过逐个确认：

```powershell
vrc-get repo import repositories.json --yes
```

这两个配合起来可以跨机器复刻一套仓库配置。
