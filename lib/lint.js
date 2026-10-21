/**
 * Constraint scan over produced artifacts — REPORT ONLY.
 *
 * Every rule below is transcribed from the knowledge library, with the source
 * page recorded on the rule itself. Rules are NOT written from memory: the
 * authoritative lists are
 *   - `entities/api/not-exposed.md`      (official NOT-EXPOSED blacklist, SDK 3.10.3)
 *   - `concepts/rules/udonsharp-language-limits.md`  (RULE-LL-01..14)
 *   - `concepts/rules/networking-rules.md`
 *   - `concepts/rules/performance-rules.md`
 *
 * Deliberately not a guard: nothing here blocks, mutates, or auto-fixes. It
 * answers one question on request and returns findings. The caller decides what
 * to do with them, including knowingly ignoring some to reach an effect.
 *
 * Coverage is honest: only mechanically decidable rules are implemented, and
 * every finding cites the rule it came from plus the documented replacement.
 * A clean report is NOT a verdict that the artifact is correct.
 */
import { basename } from "node:path";

const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };

/**
 * Two views of one source, both preserving line numbers exactly:
 *
 *   code view    comments blanked, literal contents sentinel-ized
 *                → code rules can never match prose inside a comment or string
 *   literal view comments blanked, literal contents KEPT
 *                → rules that must READ a literal (a shader property name) can
 *
 * A single view cannot serve both: blanking contents hides `"_UdonMyColor"`,
 * while keeping them makes a comment saying "禁止 async" look like code.
 *
 * @param source - raw file text.
 * @param keepLiterals - retain quoted contents instead of sentinel-izing them.
 */
export function stripNoise(source, keepLiterals = false) {
  const out = [];
  let i = 0;
  const n = source.length;
  let mode = "code";
  const SENTINEL = "\u0000";

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        mode = ch === '"' ? "double" : "single";
        out.push(ch);
        i += 1;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out.push("\n");
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }

    // Inside a quoted literal.
    if (ch === "\\") {
      out.push(keepLiterals ? source.slice(i, i + 2) : SENTINEL + SENTINEL);
      i += 2;
      continue;
    }
    if ((mode === "double" && ch === '"') || (mode === "single" && ch === "'")) {
      mode = "code";
      out.push(ch);
      i += 1;
      continue;
    }
    out.push(ch === "\n" ? "\n" : keepLiterals ? ch : SENTINEL);
    i += 1;
  }

  return out.join("");
}

/** Does the file live in an `Editor` folder (any depth)? */
function inEditorFolder(path) {
  const parts = path.split("/");
  parts.pop();
  return parts.some((segment) => segment.toLowerCase() === "editor");
}

/** Concatenate the bodies of every method whose header matches. */
function bodyLines(lines, headerPattern) {
  const collected = [];
  let pending = false;
  let depth = 0;
  let active = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!active && headerPattern.test(line)) pending = true;
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        if (pending) {
          active = true;
          pending = false;
        }
      } else if (ch === "}") {
        depth -= 1;
        if (active && depth <= 0) active = false;
      }
    }
    if (active) collected.push(index + 1);
  }
  return new Set(collected);
}

/** Every line inside a synchronous per-frame callback. */
function hotPathLines(lines) {
  return bodyLines(lines, /\b(?:void|override\s+void)\s+(?:Update|FixedUpdate|LateUpdate)\s*\(/);
}

/**
 * Rule table. `when` runs on a trimmed, comment-stripped line; `alternative` is
 * copied from the library so a report tells the reader what to use instead.
 */
const RULES = [
  // ── not-exposed.md §System ────────────────────────────────────────────────
  {
    id: "notexposed-system-namespace",
    severity: "high",
    extensions: [".cs"],
    title: "使用了 Udon 禁止的 System 命名空间",
    because: "System.IO / Net / Threading / Reflection 在 Udon 中整体未暴露。",
    alternative: "Udon 不提供文件、网络、多线程与反射能力；改用 VRC 的字符串加载 / 网络 API / 单线程事件。",
    ref: "entities/api/not-exposed.md §System 命名空间",
    when: (line) => /^\s*using\s+System\.(?:IO|Net|Threading|Reflection)\b/.test(line) ||
      /\bSystem\.(?:IO|Net|Threading|Reflection)\.[A-Za-z]/.test(line),
  },
  {
    id: "notexposed-dynamic-creation",
    severity: "high",
    extensions: [".cs"],
    title: "使用了反射/动态创建",
    because: "System.Type.GetType() 与 Activator.CreateInstance() 未暴露；Udon VM 无反射。",
    alternative: "改用显式类型与工厂方法，或预先在编辑器里配置对象。",
    ref: "entities/api/not-exposed.md §System 命名空间",
    when: (line) => /\bActivator\s*\.\s*CreateInstance\b/.test(line) ||
      /\bType\s*\.\s*GetType\s*\(/.test(line) ||
      /\bGetType\s*\(\s*\)\s*\./.test(line),
  },

  // ── not-exposed.md §GameObject / Component / Object ───────────────────────
  {
    id: "notexposed-sendmessage",
    severity: "high",
    extensions: [".cs"],
    title: "使用了未暴露的 SendMessage 系列",
    because: "GameObject.SendMessage / BroadcastMessage / SendMessageUpwards 均 NOT EXPOSED。",
    alternative: "改用 SendCustomEvent / SendCustomNetworkEvent。",
    ref: "entities/api/not-exposed.md §GameObject",
    when: (line) => /\.\s*(?:SendMessage|BroadcastMessage|SendMessageUpwards)\s*\(/.test(line),
  },
  {
    id: "notexposed-comparetag",
    severity: "medium",
    extensions: [".cs"],
    title: "使用了未暴露的 CompareTag / tag 属性",
    because: "Component.CompareTag() 与 tag 属性在 Udon 中 NOT EXPOSED。",
    alternative: "改用 LayerMask 或自定义标记字段。",
    ref: "entities/api/not-exposed.md §Component",
    when: (line) => /\.\s*CompareTag\s*\(/.test(line) || /\.\s*tag\b(?!\s*=)/.test(line),
  },
  {
    id: "notexposed-trygetcomponent",
    severity: "medium",
    extensions: [".cs"],
    title: "使用了未暴露的 TryGetComponent",
    because: "Component.TryGetComponent<T>() 在 Udon 中 NOT EXPOSED。",
    alternative: "改用 GetComponent<T>() + null 检查。",
    ref: "entities/api/not-exposed.md §Component",
    when: (line) => /\.\s*TryGetComponent\s*[<(]/.test(line),
  },
  {
    id: "notexposed-destroy",
    severity: "high",
    extensions: [".cs"],
    title: "使用了未暴露的 Destroy / DestroyImmediate",
    because: "Object.Destroy() 与 DestroyImmediate() 在 Udon 中 NOT EXPOSED。",
    alternative: "改用 SetActive(false) 或对象池。",
    ref: "entities/api/not-exposed.md §Object",
    when: (line) => /\bDestroy(?:Immediate)?\s*\(/.test(line),
  },
  {
    id: "notexposed-find-static",
    severity: "high",
    extensions: [".cs"],
    title: "使用了未暴露的静态查找",
    because: "FindObjectsOfType / FindObjectOfType 与 Transform.Find 在 Udon 中 NOT EXPOSED。",
    alternative: "场景加载时缓存引用。",
    ref: "entities/api/not-exposed.md §Object / §Transform",
    when: (line) => /\bFindObjects?OfType\s*[<(]/.test(line) || /\bGameObject\s*\.\s*Find\b/.test(line) || /\.\s*Find\s*\(\s*(?:"|')/.test(line),
  },
  {
    id: "notexposed-component-ctor",
    severity: "high",
    extensions: [".cs"],
    title: "用 new 创建了 Unity 组件",
    because: "大多数 Unity 组件构造函数 NOT EXPOSED，不能用 new 创建。",
    alternative: "改用 Instantiate 预制体，或在编辑器中预先配置。",
    ref: "entities/api/not-exposed.md §构造函数限制",
    when: (line) => /\bnew\s+(?:GameObject|Rigidbody|Rigidbody2D|Mesh|Material|Collider|BoxCollider|SphereCollider|CapsuleCollider|Animator|AudioSource|ParticleSystem|Camera|Light)\s*\(/.test(line),
  },

  // ── not-exposed.md §Time ──────────────────────────────────────────────────
  {
    id: "notexposed-time-member",
    severity: "medium",
    extensions: [".cs"],
    title: "使用了未暴露的 Time 成员",
    because: "timeAsDouble / unscaledTime / unscaledTimeAsDouble / fixedTime / frameCount / maximumDeltaTime 均 NOT EXPOSED。",
    alternative: "统一使用 Time.time；帧计数自行维护。",
    ref: "entities/api/not-exposed.md §Time",
    when: (line) => /\bTime\s*\.\s*(?:timeAsDouble|unscaledTimeAsDouble|unscaledTime|fixedTime|frameCount|maximumDeltaTime)\b/.test(line),
  },

  // ── not-exposed.md §Input / §Camera ──────────────────────────────────────
  {
    id: "notexposed-input-legacy",
    severity: "high",
    extensions: [".cs"],
    title: "使用了未暴露的旧版 Input 成员",
    because: "mousePosition / mouseScrollDelta / GetTouch / touches / acceleration / gyro / ResetInputAxes 均 NOT EXPOSED。",
    alternative: "改用 VRC SDK 输入 API（InputManager / VRCHand 等）。",
    ref: "entities/api/not-exposed.md §Input",
    when: (line) => /\bInput\s*\.\s*(?:mousePosition|mouseScrollDelta|GetTouch|touches|acceleration|gyro|ResetInputAxes|IsJoystickPreconfigured)\b/.test(line),
  },
  {
    id: "notexposed-camera-static",
    severity: "medium",
    extensions: [".cs"],
    title: "使用了未暴露的 Camera 静态成员",
    because: "Camera.main / Camera.current / Camera.Render 在 Udon 中 NOT EXPOSED。",
    alternative: "场景加载时缓存引用；需要相机控制时用 VRCCameraSettings。",
    ref: "entities/api/not-exposed.md §Camera",
    when: (line) => /\bCamera\s*\.\s*(?:main|current|Render)\b/.test(line),
  },

  // ── not-exposed.md §Collections / RULE-LL-02 ─────────────────────────────
  {
    id: "udon-banned-collection",
    severity: "high",
    extensions: [".cs"],
    title: "使用了 Udon 不支持的泛型集合",
    because: "List/Dictionary/HashSet/Queue/Stack 的构造函数与方法均 NOT EXPOSED（List 仅个别类型例外）。",
    alternative: "改用 DataList / DataDictionary / DataToken，或定长数组。",
    ref: "entities/api/not-exposed.md §Collections + concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) =>
      // List<ConstraintSource> 与 List<KeyValuePair<AnimationClip, AnimationClip>> 是文档化的例外。
      (/new\s+(?:List|Dictionary|HashSet|SortedDictionary|SortedSet|Queue|Stack)\s*</.test(line) &&
        !/List\s*<\s*ConstraintSource\s*>/.test(line) &&
        !/List\s*<\s*KeyValuePair\s*<\s*AnimationClip\s*,\s*AnimationClip\s*>/.test(line)) ||
      /\b(?:Dictionary|HashSet|SortedDictionary|SortedSet)\s*</.test(line),
  },
  {
    id: "udon-banned-linq",
    severity: "high",
    extensions: [".cs"],
    title: "使用了 LINQ",
    because: "LINQ 任何形式在 Udon 中不可用。",
    alternative: "改用显式 for 循环。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) => /^\s*using\s+System\.Linq\b/.test(line) ||
      /\.\s*(?:Where|Select|SelectMany|FirstOrDefault|First|Last|Any|All|OrderBy|OrderByDescending|GroupBy|Aggregate|ToArray|ToList|Sum|Average|Count)\s*\(/.test(line),
  },

  // ── RULE-LL-02 异步/异常/协程 ────────────────────────────────────────────
  {
    id: "udon-banned-async",
    severity: "high",
    extensions: [".cs"],
    title: "使用了 Udon 不支持的 async/await",
    because: "Udon VM 不支持 async/await。",
    alternative: "改用 SendCustomEventDelayedSeconds 或状态机。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) => /\basync\s+(?:void|Task|[\w<>])/.test(line) || /\bawait\b/.test(line),
  },
  {
    id: "udon-banned-exception",
    severity: "high",
    extensions: [".cs"],
    title: "使用了 Udon 不支持的异常处理",
    because: "Udon VM 无异常处理，try/catch/finally 不可用。",
    alternative: "改用返回值与显式状态检查。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) => /\btry\s*\{/.test(line) || /\bcatch\s*(?:\(|\{)/.test(line) || /\bfinally\s*\{/.test(line) || /\bthrow\s+new\b/.test(line),
  },
  {
    id: "udon-banned-coroutine",
    severity: "high",
    extensions: [".cs"],
    title: "使用了协程 / 迭代器",
    because: "Coroutine（IEnumerator / StartCoroutine / yield return）在 Udon 中不可用。",
    alternative: "改用 SendCustomEventDelayedSeconds。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) => /\bStartCoroutine\s*\(/.test(line) || /\byield\s+return\b/.test(line) || /\bIEnumerator\s+[A-Za-z_]/.test(line),
  },

  // ── RULE-LL-02 委托 / lambda / 反射 ──────────────────────────────────────
  {
    id: "udon-banned-delegate",
    severity: "high",
    extensions: [".cs"],
    title: "使用了委托 / lambda / UnityEvent 监听",
    because: "Action/Func/delegate/lambda 与运行时 AddListener 在 Udon 中不可用。",
    alternative: "改用 SendCustomEvent。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) => /\b(?:Action|Func)\s*<\w/.test(line) ||
      /\bdelegate\b/.test(line) ||
      /=>\s*\{/.test(line) ||
      /\.\s*(?:AddListener|RemoveListener)\s*\(/.test(line),
  },
  {
    id: "udon-banned-reflection",
    severity: "high",
    extensions: [".cs"],
    title: "使用了反射或 dynamic",
    because: "System.Reflection 与 dynamic 关键字在 Udon 中不可用。",
    alternative: "改用显式类型访问。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-02",
    when: (line) => /\busing\s+System\.Reflection\b/.test(line) || /\bdynamic\s+[A-Za-z_]/.test(line) || /\btypeof\s*\(/.test(line),
  },

  // ── RULE-LL-12 方法重载 ──────────────────────────────────────────────────
  {
    id: "udon-method-overload",
    severity: "medium",
    extensions: [".cs"],
    title: "疑似方法重载（Udon 不支持）",
    because: "UdonSharp 不支持方法重载，所有方法名必须唯一（Extern 签名按方法名定位）。",
    alternative: "改用不同的方法名，如 DoInt / DoString。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-12",
    // Decided across the whole file, not per line. Two signatures collide only
    // when the name AND the parameter TYPE LIST match — arity alone is not a
    // signature: Do(int) and Do(string) are exactly the overload this catches.
    collect: (stripped) => {
      const lines = stripped.split("\n");
      const seen = new Map();
      const hits = [];
      for (let index = 0; index < lines.length; index++) {
        const match = /^\s*(?:(?:public|private|protected|internal|static|override|virtual|new)\s+)*[A-Za-z_][\w<>,\[\]\.\s]*?\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(lines[index]);
        if (match === null) continue;
        const method = match[1];
        if (["if", "for", "while", "switch", "catch", "return", "new", "using", "foreach"].includes(method)) continue;
        const params = match[2]
          .split(",")
          .map((part) => part.trim().split(/\s+/).slice(0, -1).join(" ").trim())
          .filter((part) => part.length > 0);
        const signature = params.join(",");
        if (!seen.has(method)) {
          seen.set(method, new Set([signature]));
          continue;
        }
        if (seen.get(method).has(signature)) continue;
        seen.get(method).add(signature);
        hits.push({ line: index + 1, evidence: lines[index].trim() });
      }
      return hits;
    },
  },

  // ── RULE-LL-11 override 规则 ─────────────────────────────────────────────
  {
    id: "udon-unity-callback-override",
    severity: "medium",
    extensions: [".cs"],
    title: "Unity 回调误加了 override",
    because: "只有 VRChat 事件需要 override；Unity 回调（OnTriggerEnter 等）加了 override 会报 CS0115。",
    alternative: "去掉 override。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-11",
    when: (line) =>
      /\boverride\s+void\s+(?:OnTrigger(?:Enter|Exit|Stay)|OnCollision(?:Enter|Exit|Stay)|OnMouse\w+|OnBecame\w+|OnDrawGizmos\w*)\s*\(/.test(line),
  },

  // ── RULE-LL-10 递归 ──────────────────────────────────────────────────────
  {
    id: "udon-recursive-without-attribute",
    severity: "low",
    extensions: [".cs"],
    title: "递归方法缺少 [RecursiveMethod]",
    because: "UdonSharp 要求递归方法标注 [RecursiveMethod]。",
    alternative: "在方法上方加 [RecursiveMethod]。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-10",
    collect: (stripped) => {
      const lines = stripped.split("\n");
      const hits = [];

      // Member declarations = candidate methods. Everything else is body text
      // that may contain the self-call, so it must NOT be treated as a decl.
      const declarations = [];
      // Modifiers are OPTIONAL: a bare `int Fact(int n)` is a valid declaration.
      // A type name is required, which is what keeps `return x;` from matching.
      for (let index = 0; index < lines.length; index++) {
        const match = /^\s*(?:(?:public|private|protected|internal|static|override|virtual|new)\s+)*([A-Za-z_][\w<>,\[\]\s\.]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?/.exec(lines[index]);
        if (match === null) continue;
        const typeName = match[1].trim();
        const method = match[2];
        if (/[=;]$/.test(typeName)) continue;
        if (["if", "for", "while", "switch", "catch", "return", "new", "using", "foreach", "class", "else"].includes(method)) continue;
        if (["return", "new", "else", "using"].includes(typeName)) continue;
        declarations.push({ index, method, params: match[3] });
      }

      for (let k = 0; k < declarations.length; k++) {
        const decl = declarations[k];
        const end = k + 1 < declarations.length ? declarations[k + 1].index : lines.length;
        const region = lines.slice(decl.index, end).join("\n");

        // The declaration header itself contains exactly one occurrence of
        // `method(`. A second occurrence is a self-call — this works for
        // one-line bodies too, where slicing the header off would leave nothing.
        const occurrences = region.match(new RegExp(`\\b${decl.method}\\s*\\(`, "g"));
        if (occurrences === null || occurrences.length < 2) continue;

        const header = lines[decl.index];
        const attributeLine = `${lines[decl.index - 1] ?? ""}${header}`;
        if (/\[\s*RecursiveMethod\s*\]/.test(attributeLine)) continue;
        hits.push({ line: decl.index + 1, evidence: header.trim() });
      }
      return hits;
    },
  },

  // ── RULE-LL-01 / FACT §Editor 脚本 ──────────────────────────────────────
  {
    id: "unityeditor-outside-editor",
    severity: "high",
    extensions: [".cs"],
    title: "引用 UnityEditor 的脚本不在 Editor 文件夹内",
    because: "脚本先在编辑器下编译（含 UnityEditor 程序集），再为目标平台重编（不含），跨平台构建会失败。",
    alternative: "移到任意父目录名为 Editor 的路径下，或建 asmdef 且 Include Platforms 只勾 Editor。",
    ref: "FACT.md §Editor 脚本与构建",
    when: (line, context) => /\bUnityEditor\b/.test(line) && !inEditorFolder(context.path),
  },

  // ── FACT §渲染管线 ──────────────────────────────────────────────────────
  {
    id: "urp-hdrp-pipeline",
    severity: "high",
    extensions: [".cs", ".shader"],
    title: "引用了非 BRP 渲染管线",
    because: "VRChat 只支持 Built-in Render Pipeline；URP/HDRP 会让项目完全无法工作。",
    alternative: "只使用 Built-in 管线与 BRP 兼容的 Shader。",
    ref: "FACT.md §核心约束 · 渲染管线",
    when: (line) => /\b(?:UniversalRenderPipeline|HDRenderPipeline|UniversalAdditional\w*|renderPipelineAsset)\b/i.test(line),
  },

  // ── RULE-LL-14 VRC Graphics ─────────────────────────────────────────────
  {
    id: "vrc-shader-global-prefix",
    severity: "high",
    extensions: [".cs"],
    title: "VRCShader 全局属性名缺少 _Udon 前缀",
    because: "只有 _Udon* 前缀（或字面量 _AudioTexture）的全局属性会被路由到 Udon；其余 PropertyToID 仍返回 ID 但 SetGlobal 静默失败。",
    alternative: '改用 VRCShader.PropertyToID("_UdonMyColor")。',
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-14.1",
    readsLiterals: true,
    when: (line) => {
      // Runs on the literal-preserving view, so the property name is readable.
      const match = /PropertyToID\s*\(\s*"([^"]*)"/.exec(line) ?? /PropertyToID\s*\(\s*'([^']*)'/.exec(line);
      if (match === null) return false;
      const name = match[1];
      if (name.length === 0) return false;
      return !name.startsWith("_Udon") && name !== "_AudioTexture";
    },
  },
  {
    id: "vrc-protected-shader-namespace",
    severity: "medium",
    extensions: [".shader"],
    title: "自定义 Shader 使用了受保护的 _VRChat 前缀",
    because: "_VRChat 前缀保留给引擎注入的全局变量，VRChat 可能随时新增同名变量导致覆盖。",
    alternative: "自定义全局量改用 _Udon 前缀。",
    ref: "concepts/rules/udonsharp-language-limits RULE-LL-14.5",
    when: (line) => /^\s*(?:float|half|float2|float3|float4|int|Texture2D|sampler2D)\s+_VRChat\w+/.test(line),
  },

  // ── Performance §热路径 ─────────────────────────────────────────────────
  {
    id: "hotpath-getcomponent-find",
    severity: "medium",
    extensions: [".cs"],
    title: "在每帧回调里调用 GetComponent / Find / Debug.Log",
    because: "Update/FixedUpdate/LateUpdate 中查找组件、查找对象、打印日志会造成严重性能问题。",
    alternative: "在 Start() 中缓存引用；日志改为条件编译或移除。",
    ref: "concepts/rules/performance-rules + FACT.md §World 性能",
    when: (line, context) =>
      /\bGetComponent(?:s|InChildren|InParent)?\s*[<(]/.test(line) ||
      /\bGameObject\s*\.\s*Find\b/.test(line) ||
      /\bDebug\s*\.\s*Log(?:Warning|Error)?\s*\(/.test(line)
        ? context.hotLines.has(context.line)
        : false,
  },
];

/**
 * Scan one file's text against the rule table.
 * @param path - path used for reporting and the Editor-folder rule.
 * @param source - raw text.
 * @returns findings, each carrying the rule that produced it.
 */
export function lintSource(path, source) {
  const extension = `.${basename(path).split(".").pop().toLowerCase()}`;
  const code = stripNoise(source);
  // Rules that must read a literal get the literal-preserving view instead.
  // Everything else sees the code view, where comment and string contents are
  // inert — that is what keeps a comment saying "禁止 async" from firing.
  const withLiterals = stripNoise(source, true);
  const views = { code, literals: withLiterals };
  const codeLines = code.split("\n");
  const literalLines = withLiterals.split("\n");
  const hotLines = hotPathLines(codeLines);
  const findings = [];

  for (const rule of RULES) {
    if (!rule.extensions.includes(extension)) continue;

    if (rule.collect !== undefined) {
      for (const hit of rule.collect(code)) {
        findings.push({
          file: path,
          line: hit.line,
          rule: rule.id,
          severity: rule.severity,
          title: rule.title,
          because: rule.because,
          alternative: rule.alternative,
          ref: rule.ref,
          evidence: hit.evidence.slice(0, 160),
        });
      }
      continue;
    }

    const lines = rule.readsLiterals === true ? literalLines : codeLines;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.trim().length === 0) continue;
      if (!rule.when(line, { path, line: index + 1, hotLines, views })) continue;
      findings.push({
        file: path,
        line: index + 1,
        rule: rule.id,
        severity: rule.severity,
        title: rule.title,
        because: rule.because,
        alternative: rule.alternative,
        ref: rule.ref,
        evidence: line.trim().slice(0, 160),
      });
    }
  }

  return findings;
}

/** Sort and filter a finding list for display. */
export function rankFindings(findings, minSeverity = "low") {
  const floor = SEVERITY_ORDER[minSeverity] ?? 1;
  return findings
    .filter((finding) => (SEVERITY_ORDER[finding.severity] ?? 0) >= floor)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );
}

/** Rule inventory, so a report can state exactly what it did and did not check. */
export function ruleInventory() {
  return RULES.map(({ id, severity, title, extensions, ref }) => ({ id, severity, title, extensions, ref }));
}
