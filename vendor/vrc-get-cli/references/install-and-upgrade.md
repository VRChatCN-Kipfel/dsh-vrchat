# 装包与升级：install / upgrade / downgrade / remove / reinstall / resolve

**这五个命令的区别是语义，不是参数。** 用错了不会报错，只会静默做错事。

## 核心差异

| 命令 | 改 `dependencies` | 改已锁的版本 | 用途 |
|---|---|---|---|
| `install <id> [ver]` | **会** | 会 | 新装一个包 |
| `upgrade [name] [ver]` | **不会** | 会 | 升级工程里**已经有的**包 |
| `downgrade <name> <ver>` | 不会 | 会 | 降到指定版本（版本必填） |
| `remove <name>...` | 会（删） | 会 | 移除 |
| `reinstall <name>...` | 不会 | 重装 | 强制重下重解 |
| `resolve` | 不会 | 按 lock 补齐 | CI / 恢复工程 |

源码注释的原话（`install` 与 `upgrade` 共用同一段说明）：

> With install command, you'll add to dependencies. With upgrade command, you'll upgrade
> dependencies or locked dependencies **but not add to dependencies**.

**所以：想装一个工程里没有的包，必须 `install`。用 `upgrade` 装不进去，而且它不报错。**

## 常用形态

```powershell
# 装机箱里已有的某个包（最新版）
vrc-get install com.vrchat.udonsharp -p "E:\MyProject"

# 装指定版本
vrc-get install com.vrchat.worlds 3.7.1 -p "E:\MyProject"

# 装预发布版
vrc-get install com.example.tool --prerelease

# 升到最新（只动已有依赖）
vrc-get upgrade -p "E:\MyProject"

# 只升某一个
vrc-get upgrade liltoon -p "E:\MyProject"

# 降级（版本必须给）
vrc-get downgrade liltoon 1.4.9 -p "E:\MyProject"

# 移除多个
vrc-get remove com.example.a com.example.b --yes

# 按 lock 把依赖装回去（CI 恢复常用）
vrc-get resolve -p "E:\MyProject"
```

## 参数速查

`install` / `upgrade` / `downgrade` 共有：

```
-p, --project <PATH>   工程目录；默认 CWD 或父目录
    --prerelease       允许预发布版
-p 之外的：
-y, --yes              跳过确认
    --offline          只用本地缓存（隐含 --no-update）
    --no-update        不刷新仓库缓存
```

`install` 独有：`-n, --name` —— **按显示名而不是包名安装**。源码标注这是实验特性：

> This option is experimental and behavior may change in the future.

用它可以接受 `lilToon` 这种人类写法，但**自动化流程里优先用包名**，别依赖实验参数。

`remove` / `reinstall` 的 `names` 是 **variadic**（可多个），`downgrade` 的 name 和 version
都是**必填位置参数**，顺序不能换。

## 安全要点

**1. 自动执行必须给 `-y`。** 这几个命令默认会交互确认，无人值守时会卡住。

**2. 写之前先看现状。** 不要凭印象装：

```powershell
vrc-get info project -p "E:\MyProject" --json-format 1
```

它会给出 Unity 版本、已锁包、已装但未锁的包。先看一眼再动手，比装错了再回滚便宜。

**3. `remove` 会真删。** 工程里若有人手工改过包内容，`remove` 之后找不回来。
不确定就先 `git status` 确认工程本身在版本控制里。

**4. `resolve` 会按 `Packages/packages-lock.json` 重装。** 如果有人手动改过依赖却没更新
lock，`resolve` 会把它拉回 lock 的状态——**这正是它该做的，也是它会让你意外的原因**。
想保留手改，就不要跑 `resolve`。

## 装完之后

VPM 的改动落在 `Packages/manifest.json` 与 `Packages/packages-lock.json`。
Unity 下次打开工程时会自己解析，**不需要在 Package Manager 里点任何按钮**。

如果 Unity 正开着，刷新即可；如果 Unity 没开，下次打开就是新状态。
