# Shader 域核心约束（渲染管线 / 变体 / Quest 规则）

## 渲染管线（绝对规则）

```
VRChat 只支持 BRP（Built-in Rendering Pipeline）
禁止 URP / HDRP
禁止切换渲染管线（致命，项目直接不可用）
→ 该约束适用于全部 Avatar Shader：Poiyomi / lilToon / SCSS / ORL / UnlitWF
```

## Poiyomi 变体速查

| 变体 | 平台 | 性能 | 适用 |
|---|---|---|---|
| Nano | PC + Quest | 最高 | 极简 Avatar |
| Micro | Quest 首选 | 高 | Quest Avatar |
| Mega | PC 通用 | 中 | 标准 PC Avatar |
| Giga | PC 高端 | 低 | 复杂 PC Avatar |
| Tera | 顶级 PC | 最低 | 顶级视觉效果 |

## Poiyomi Pro vs Toon

| 功能 | Toon | Pro |
|---|---|---|
| 5 变体 + 基础效果 | 有 | 有 |
| Modular Shader System | 无 | 有 |
| Poiyomi Fur（1–31 层） | 无 | 有 |
| ShatterWave / Geometric Dissolve | 无 | 有 |
| Constellation（星空）/ Voronoi 3D | 无 | 有 |
| Global Themes（4 主题） | 无 | 有 |
| 价格 | 免费 | Patreon $10+/月 |

## Quest Avatar 硬性规则

```
必须用 Micro 或 Nano 变体
禁用 Grab Pass / ShatterWave / Geometric Dissolve
禁用 Voronoi 3D / Constellation / Internal Parallax
AudioLink 限 4 频段（Micro）
Material 数量 ≤ 5
```

## Shader 选择决策

```
1. 风格化 + VFX（星空/几何）      → Poiyomi Pro
2. 通用 + 大量预设 + 开源          → lilToon
3. 极致 Toon + UV 服装切换         → SCSS
4. 国内网络环境稳定优先            → lilToon / SCSS（Poiyomi mirror 常失败）
```
