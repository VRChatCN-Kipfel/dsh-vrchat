# 迁移旧工程：migrate vpm / migrate unity2022

这两个命令处理**历史遗留工程**，会改动工程结构，高风险，必须先确认再跑。

## migrate vpm

把一个**旧的 unitypackage 形式 VRCSDK 工程**迁移成 VPM 工程。

```powershell
vrc-get migrate vpm -p "E:\OldProject"
```

### 什么时候需要它

老工程的 `Assets/` 里躺着解包出来的 VRCSDK（`Assets/VRCSDK/` 之类），
`Packages/manifest.json` 里没有 VPM 依赖。这种工程：

- `vrc-get install` 装不进去（它不是 VPM 工程）
- Unity 里不会有 VRChat SDK 控制面板
- 无法用 `outdated` / `upgrade` 管理

`migrate vpm` 就是把它转成 VPM 形式。

### 风险

**它会动 `Assets/` 里的东西。** 迁移前必须确认工程在版本控制里：

```powershell
cd "E:\OldProject"
git status --short        # 有未提交改动就先停
```

没有 git 的话，先整目录复制一份。**不要在没有退路的情况下跑迁移。**

## migrate unity2022

把工程迁移到 Unity 2022，**必须指定 Unity 2022 的可执行文件路径**：

```powershell
vrc-get migrate unity2022 -p "E:\MyProject" --unity "C:\Program Files\Unity\Hub\Editor\2022.3.22f1\Editor\Unity.exe"
```

`--unity` 是**必填**，不给会直接报用法错误。

### 和 VRChat SDK 版本绑定的关系

VRChat SDK 对 Unity 版本有硬绑定：**SDK 3.5.0+ 要 2022.3.22f1；SDK 3.4.2 及更早是 2019.4.31f1**。

所以迁移到 2022 之前，先确认工程要用的 SDK 版本落在哪一侧。**SDK 版本没跟上的工程贸然升级
Unity，结果通常是打包失败**——这个后果比迁移本身更难排查。

不确定时先看：

```powershell
vrc-get info project -p "E:\MyProject"
```

它会报当前 Unity 版本；再看 `Packages/manifest.json` 里的 SDK 依赖版本。

## 决策顺序

```
工程能正常打开、VPM 依赖也正常？
   └─ 是 → 什么都不要做

manifest.json 里没有 VPM 依赖、Assets 里有解包的 VRCSDK？
   └─ migrate vpm

工程是 VPM 的，但 Unity 版本是 2019 而 SDK 要 2022？
   └─ 先确认 SDK 已升到 3.5.0+，再 migrate unity2022
```

**两个迁移都不要自动跑。** 先向用户说明会发生什么、确认工程有备份，再执行。
