# VRChat 创作者知识库 · 覆盖范围

上游：`RhineLab-magellan/VRChat-Agent-Creator-Library` v5.0.0（页数见 `/vrchat stats`）。
本地权威度标记来自每页 frontmatter 的 `confidence` 字段（high / medium / low）。

## 覆盖域与入口

| 域 | 内容 | 查这些关键词 |
|---|---|---|
| World | Udon 编程、UdonSharp 语言限制、网络同步、Persistence、场景组件、光照烘焙、示例工程 | udon, udonsharp, synced, network, persistence, 组件 |
| Avatar | Animator、Playable Layers、PhysBone、改模、优化、表情参数 | animator, physbone, blendshape, 表情, 优化 |
| Shader | lilToon / Poiyomi / ORL / Filamented / UnlitWF、渲染管线、Quest 变体 | shader, toon, poiyomi, liltoon |
| API | Udon API 参考（Networking / Player / 动画 / 音频 / UI） | api, player, pickup, event |
| VRChatSDK | VRChat HTTP API、WebSocket、数据模型 | api, websocket, sdk |
| Platform | Quest / Android、跨平台、Unity 工具链 | quest, android, 移动端 |
| 设计模式 | 同步模式、状态机、消息总线、位压缩 | pattern, 模式 |
| 规范红线 | UdonSharp 限制、网络规则、性能规则、VM 硬约束 | rule, 限制, 红线 |
| 混合域 | OSC、AudioLink、VCC / ALCOM、Avatar↔World 桥接 | osc, audiolink, vcc, alcom |
| 工具链 | VRCFury、Modular Avatar、AAO、TTT、NDMF、Meshia | vrcfury, modular avatar, ndmf, 工具 |

## 不覆盖

通用 Unity 开发、C#/.NET 语言特性、VRChat 账号与社群运营细节，
以及**建模本体的通用美术制作**（建立模型、雕刻、UV 展开、贴图绘制、动画制作）。
这类问题请直接用你的通用知识作答，**不要**把它当作本库内容来检索。

## 覆盖：外部 DCC → Unity 的交接段

上面那条"不覆盖"指的是**建模本体**，不是"凡是 Blender 就不查库"。资产从外部工具进
Unity 的这一段是**覆盖的**，而且是本库最容易查错的一块：

| 主题 | 本库页面 | 检索词 |
|---|---|---|
| Blender 形态键 → Unity BlendShapes（含 FBX 导出/导入设置、Humanoid 必需骨骼） | `entities/avatar/blender-shape-keys.md` | blender, 形态键, shapes keys, blendshape, fbx |
| 骨骼绑定与 Humanoid 约束 | `entities/avatar/bone-binding-workflow.md` | armature, 绑定, 骨骼, humanoid, 权重 |
| 形态键不生效的排查 | `entities/avatar/blend-shape-troubleshooting.md` | blendshape, 排查, 不显示 |
| 改模全流程 | `entities/avatar/avatar-modding-guide.md` | 改模, modding, 导入导出 |

问"Blender 里改了 X，Unity 里不对"这类问题，**先查这里**（检索词带上 blender / fbx /
armature），查不到再回落到通用知识。不要因为它是 Blender 就直接放弃检索。
