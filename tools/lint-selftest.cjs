/**
 * Offline self-test for the constraint scan.
 *
 * Every positive fixture mirrors a documented rule; every negative fixture is a
 * documented EXCEPTION or a comment/string payload that must stay silent — if a
 * negative case regresses, the tool becomes noise and the "black magic" workflow
 * loses its deliberate-ignore story.
 *
 * Usage: node tools/lint-selftest.cjs
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const wrappers = (body) => `using UdonSharp;\npublic class T : UdonSharpBehaviour {\n${body}\n}`;

const FIXTURES = [
  // ── positives: each comes from a documented rule ──────────────────────────
  {
    name: "System.IO —— 命名空间未暴露",
    path: "Assets/Scripts/A.cs",
    source: "using System.IO;\npublic class A { }",
    expect: ["notexposed-system-namespace"],
  },
  {
    name: "SendMessage —— 未暴露",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { gameObject.SendMessage(\"X\"); }"),
    expect: ["notexposed-sendmessage"],
  },
  {
    name: "Destroy —— 未暴露",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { Destroy(gameObject); }"),
    expect: ["notexposed-destroy"],
  },
  {
    name: "Time.frameCount —— 未暴露",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var f = Time.frameCount; }"),
    expect: ["notexposed-time-member"],
  },
  {
    name: "Camera.main —— 未暴露",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var c = Camera.main; }"),
    expect: ["notexposed-camera-static"],
  },
  {
    name: "Input.mousePosition —— 未暴露",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var p = Input.mousePosition; }"),
    expect: ["notexposed-input-legacy"],
  },
  {
    name: "new List<int> —— 泛型集合禁用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var l = new List<int>(); }"),
    expect: ["udon-banned-collection"],
  },
  {
    name: "LINQ .Where —— 禁用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var r = items.Where(x => x > 0); }"),
    expect: ["udon-banned-linq"],
  },
  {
    name: "async/await —— 禁用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("async void Go() { await Task.Delay(1); }"),
    expect: ["udon-banned-async"],
  },
  {
    name: "try/catch —— 禁用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { try { F(); } catch { } }"),
    expect: ["udon-banned-exception"],
  },
  {
    name: "StartCoroutine —— 禁用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { StartCoroutine(Run()); }"),
    expect: ["udon-banned-coroutine"],
  },
  {
    name: "AddListener —— 委托禁用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { btn.onClick.AddListener(Handler); }"),
    expect: ["udon-banned-delegate"],
  },
  {
    name: "Unity 回调误加 override",
    path: "Assets/Scripts/A.cs",
    source: wrappers("public override void OnTriggerEnter(Collider o) { }"),
    expect: ["udon-unity-callback-override"],
  },
  {
    name: "Update 内 GetComponent —— 热路径",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Update() { var r = GetComponent<Rigidbody>(); }"),
    expect: ["hotpath-getcomponent-find"],
  },
  {
    name: "PropertyToID 无 _Udon 前缀 —— 静默失败",
    path: "Assets/Scripts/A.cs",
    source: wrappers('void Go() { int id = VRCShader.PropertyToID("MyColor"); }'),
    expect: ["vrc-shader-global-prefix"],
  },
  {
    name: "Shader 使用 _VRChat 前缀",
    path: "Assets/Shaders/A.shader",
    source: "Shader \"X\" { }\nfloat4 _VRChatMyVar;",
    expect: ["vrc-protected-shader-namespace"],
  },
  {
    name: "UnityEditor 在普通目录",
    path: "Assets/Scripts/A.cs",
    source: "using UnityEditor;\npublic class A { }",
    expect: ["unityeditor-outside-editor"],
  },
  {
    name: "URP 引用",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var a = GraphicsSettings.renderPipelineAsset; }"),
    expect: ["urp-hdrp-pipeline"],
  },
  {
    name: "方法重载",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Do(int x) { }\n  void Do(string s) { }"),
    expect: ["udon-method-overload"],
  },
  {
    name: "递归方法缺 [RecursiveMethod]",
    path: "Assets/Scripts/A.cs",
    source: wrappers("int Fact(int n) { return n <= 1 ? 1 : n * Fact(n - 1); }"),
    expect: ["udon-recursive-without-attribute"],
  },

  // ── negatives: documented exceptions and noise that must stay silent ──────
  {
    name: "负例 · List<ConstraintSource> 是文档化例外",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var l = new List<ConstraintSource>(); }"),
    expect: [],
  },
  {
    name: "负例 · Editor 目录内的 UnityEditor",
    path: "Assets/Scripts/Editor/A.cs",
    source: "using UnityEditor;\npublic class A { }",
    expect: [],
  },
  {
    name: "负例 · Start() 里 GetComponent 不算热路径",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Start() { var r = GetComponent<Rigidbody>(); }"),
    expect: [],
  },
  {
    name: "负例 · 注释与字符串里的违禁词（黑魔法场景）",
    path: "Assets/Scripts/A.cs",
    source: wrappers(
      '// 这里不能用 List<int> 与 async\n  /* try/catch 也不行 */\n  string note = "禁止 Calculate 与 Dictionary";',
    ),
    expect: [],
  },
  {
    name: "负例 · PropertyToID 用了 _Udon 前缀",
    path: "Assets/Scripts/A.cs",
    source: wrappers('void Go() { int id = VRCShader.PropertyToID("_UdonMyColor"); }'),
    expect: [],
  },
  {
    name: "负例 · PropertyToID 用字面量 _AudioTexture",
    path: "Assets/Scripts/A.cs",
    source: wrappers('void Go() { int id = VRCShader.PropertyToID("_AudioTexture"); }'),
    expect: [],
  },
  {
    name: "负例 · 普通数组代替 List",
    path: "Assets/Scripts/A.cs",
    source: wrappers("void Go() { var a = new GameObject[16]; }"),
    expect: [],
  },
  {
    name: "负例 · 非递归方法",
    path: "Assets/Scripts/A.cs",
    source: wrappers("int Twice(int n) { return n * 2; }"),
    expect: [],
  },
];

async function main() {
  const mod = await import(pathToFileURL(join(__dirname, "..", "lib", "lint.js")).href);

  const inventory = mod.ruleInventory();
  console.log(`规则 ${inventory.length} 条：`);
  for (const rule of inventory) {
    console.log(`  [${rule.severity.padEnd(6)}] ${rule.id.padEnd(34)} ${rule.title}`);
    console.log(`             ${rule.ref}`);
  }
  console.log("");

  let failed = 0;
  for (const fixture of FIXTURES) {
    const findings = mod.lintSource(fixture.path, fixture.source);
    const got = [...new Set(findings.map((f) => f.rule))].sort();
    const want = [...new Set(fixture.expect)].sort();
    const ok = got.length === want.length && got.every((rule, i) => rule === want[i]);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${fixture.name}`);
    if (!ok) {
      console.log(`      want: ${want.length === 0 ? "(none)" : want.join(", ")}`);
      console.log(`      got : ${got.length === 0 ? "(none)" : got.join(", ")}`);
      for (const finding of findings) {
        console.log(`        ${finding.severity} L${finding.line} ${finding.rule} :: ${finding.evidence}`);
      }
    }
  }

  console.log("");
  console.log(failed === 0 ? `全部 ${FIXTURES.length} 条通过` : `${failed} / ${FIXTURES.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
