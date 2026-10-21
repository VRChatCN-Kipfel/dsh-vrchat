# World 域核心约束（Udon / 同步 / Persistence / 性能）

## 代码生成前 30 秒自检

```
□ 用了 List/Dictionary/LINQ/lambda?
□ 用了 async/try-catch/coroutine?
□ 用了 internal / NoVariableSync / partial?
□ Manual Sync → 调了 RequestSerialization()?
□ 同步了 String / DisplayName?
□ Update 里分配内存 / 调 EXTERN?
□ 热路径 GetComponent / Find?
□ 非 Owner 在写 UdonSynced?
□ Enum 比较 cast 到 int 了?
□ 这个 API 在 Udon 里暴露了吗?
```

## 禁止清单

| 类别 | 禁止项 |
|---|---|
| 集合 | `List<T>`、`Dictionary`、LINQ |
| 异步 | `async`/`await`、`try`/`catch`、coroutine |
| 泛型 | lambda、delegate、`AddListener` |
| 关键字 | `internal`、`partial`、`NoVariableSync` |
| 热路径 | `GetComponent`、`Find`、`Debug.Log`、字符串拼接、分配内存、`EXTERN` |
| 同步 | `String`、`DisplayName`、Collision Ownership Transfer |
| 持久化 | 在 `OnPlayerJoined` 写数据、无前缀 Key、PlayerData 存数组/字典（改用 `byte[]` + `VRCJson`） |

## 网络同步核心

```
1. Owner 写入 → Manual + RequestSerialization()
2. Late joiner → 必须 [UdonSynced]
3. Continuous → 丢包不重传，仅用于连续数据
4. Manual → 多变量时 OnDeserialization 可能分帧
5. [NetworkCallable] → SDK 3.8.1+，8 参数上限
6. SetOwner → 本地立即生效
7. 非 Owner 写入 → 静默回退
8. `_` 前缀的 public 成员 → 防网络事件调用
```

## 带宽与载荷预算（硬数字，设计前必查）

```
总带宽              ≈ 11 KB/s（整个 World 所有同步共享）
Manual sync         280,496 bytes / 次序列化
Continuous sync     ≈ 200 bytes / 次序列化
→ 据此反推同步频率：Manual 大载荷低频，Continuous 小载荷高频，
  两者相加不得超过 11 KB/s，否则整体降级
```

## VRCGraphics 全局着色器参数

```
VRCShader.SetGlobal 的属性名必须以 `_Udon` 为前缀
→ 否则全局设置不生效
```

## VM 性能事实

- Udon VM 是**纯解释器，仅 9 条指令**，比 C# 慢 200x–1000x。
- 每个变量都是 `StrongBox<T>`（装箱/拆箱开销）。
- `EXTERN` 是最昂贵的指令。
- 脚本有 **10 秒硬限制** → 超时 Behaviour 永久停止。
- `Instantiate` 一个 Udon prefab ≈ 2ms。

## Persistence 核心约束

```
1. 100KB 配额 / 玩家 / World（压缩后）；PlayerData 与 PlayerObject 配额独立
2. 必须在 OnPlayerRestored 之后读写（OnPlayerJoined 写会被服务器数据覆盖）
3. 写本地玩家的 PlayerData，或自己的 PlayerObject（写错 player 静默失败）
4. Key 不可删除，只能 Set 覆盖（用空值/0 软删）
5. PlayerData 写 = 发送全部 PlayerData，高频写走 PlayerObject
6. PlayerObject 所有权不可转移；必须加 VRCEnablePersistence 才持久化
7. Key 命名空间用 <Prefab名>-<功能> 前缀避免冲突
8. 字符串值 ~50 字符，Key 名 128 字符（建议上限）
```

## Enum 5 个陷阱

1. `ToString()` → 输出数字
2. cast 不能与操作符写在一起
3. 可选参数不能用 Enum 默认值
4. 非用户 Enum 比较 → cast 到 `int`
5. `var max = TWO; max >= TWO` → 结果为 false（先转 int）
