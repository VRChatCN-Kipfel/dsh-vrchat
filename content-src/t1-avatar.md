# Avatar 域核心约束（Animator / 性能 / 参数 / Shader 规则）

## Animator — Playable Layers 播放顺序

```
Base → Additive → Gesture → Action → FX（最后，优先级最高）
```

## Animator 关键规则

```
1. 前四层（Base/Additive/Gesture/Action）只控制 Transform 和 GameObject 开关
2. Blendshape / 材质替换 / 着色器动画 → 必须在 FX 层
3. 禁止同一控制器内混用 Write Defaults On/Off
4. WD Off 状态必须有填充动画（空属性 + 至少 2 帧）
5. FX 层用 WD Off 控制 Transform → 会覆盖 Gesture 层所有 Transform
6. Direct Blend Tree → 必须 Write Defaults On
7. 单 State 的 Direct BT 例外，可单独使用任意 WD
```

## Quest / Android 性能硬约束

```
□ 面数 ≤ 20,000（Poor 线），推荐 ≤ 10,000
□ 材质内存 ≤ 40 MB（Poor 线）
□ 骨骼 ≤ 150（Medium 线），推荐 ≤ 75
□ PhysBone 组件 ≤ 8（Poor 线）
□ 粒子系统 ≤ 2（Poor 线）
□ 只能使用 VRChat/Mobile/ 目录下的 Shader
□ 只能使用 VRChat Constraints（Unity Constraints 禁用）
☆ Very Poor 评级未来可能被完全删除
```

## Expression 参数

**配额**：synced 合计 **256 bits**（含 unsynced 合计 8192 个）。超过 256 会加载失败；第三方工具通常需要预留 8–16 bit 缓冲。

Animator ↔ Expression 类型转换：

| Animator \ Expression | Bool | Int | Float |
|---|---|---|---|
| Bool → | 直接传递 | 0/1 | 0.0/1.0 |
| Int → | >0 = True | 直接传递 | 直接转换 |
| Float → | >0 = True | 四舍五入 | 直接传递 |

## Avatar Mask 行为

- 启用 Humanoid Muscle → 可修改该值；禁用 → 不能修改
- 启用 Transform → 可改位置/旋转/缩放 + 替换第一材质球；禁用 → 不能修改
- 有 Avatar Mask → 不能控制除第一个以外的材质球

## 第三方工具链兼容性

| 工具 | VRCSDK 最低 | MA 最低 | 表情参数 |
|---|---|---|---|
| VRCFury / AAO | 与 SDK 一致 | N/A（AAO 需 1.x） | N/A |
| VirtualLens2 | 3.7.0+ | 1.8.0+ | 8 bit |
| VRCLens | 3.0.8+ | 集成 AV3Manager | 8 bit |

工具设计哲学：Non-Destructive（VRCFury / MA / VirtualLens2）vs Invasive（VRCLens）—— 选择取决于 Avatar 复用场景。

**Shader Locking**：上传时 VRChat 自动 Lock 材质（剥离未用功能、烘焙常量、属性不可动画）。Poiyomi 有 `Animated` / `Renamed` 标记可保持属性可动画；lilToon 无内置机制需手动 Lock；d4rkAvatarOptimizer **不支持** Poiyomi Renamed 模式。

## Avatar 相机已知问题（官方 tracked，未解决）

```
1. Avatar Camera 不响应 DepthTextureMode → DoF 与 shader 行为异常
2. DoF 噪声无法关闭 → 视频录制与后期降噪困难
3. Avatar 相机使用 stale depth texture → 深度相关效果失效
```
