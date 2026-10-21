/**
 * Offline self-test for Unity runtime discovery.
 *
 * Focus: evidence comes from command lines and project files. There must be NO
 * port-scanning path, and "found nothing" must produce actionable next steps
 * rather than a shrug.
 *
 * Usage: node tools/unity-status-selftest.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REAL_PROJECT = "E:\\Users\\30885\\gitui-merge-fixture";

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "unity-status.js")).href);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── command line parsing ────────────────────────────────────────────────
  const hubLine = '"D:\\Program Files\\Unity Hub\\Unity Hub.exe" "--" "--silent" "--" "-projectPath" "E:\\proj\\demo"';
  const hub = mod.parseCommandLine(hubLine);
  check("解析 -projectPath", hub.args.projectPath === "E:\\proj\\demo", JSON.stringify(hub.args.projectPath));
  check("裸 -- 被跳过而不是当成值", hub.args.silent === true, JSON.stringify(hub.args));

  const eq = mod.parseCommandLine("Unity.exe -projectPath=E:/p/x -batchmode");
  check("解析 -flag=value", eq.args.projectPath === "E:/p/x", JSON.stringify(eq.args.projectPath));
  check("解析布尔开关", eq.args.batchmode === true);

  const spaced = mod.parseCommandLine('Unity.exe -projectPath "E:/my projects/demo"');
  check("引号内空格不切断", spaced.args.projectPath === "E:/my projects/demo");

  check("空命令行安全", mod.parseCommandLine(undefined).raw === "");

  // ── process classification ──────────────────────────────────────────────
  const hubProc = mod.classifyProcess({ pid: 100, name: "Unity Hub", executablePath: "D:/Hub/Unity Hub.exe", commandLine: hubLine });
  check("Hub 被识别", hubProc?.kind === "hub");
  check("Hub 带出项目路径", hubProc?.projectPath === "E:\\proj\\demo");

  const editorProc = mod.classifyProcess({
    pid: 200, name: "Unity.exe", executablePath: "D:/Editor/Unity.exe",
    commandLine: 'Unity.exe -projectPath "D:/proj/game" -batchmode',
  });
  check("编辑器被识别", editorProc?.kind === "editor");
  check("编辑器带出项目路径", editorProc?.projectPath === "D:/proj/game");
  check("识别无头模式", editorProc?.batchMode === true);

  check("授权客户端不被当成编辑器", mod.classifyProcess({ pid: 300, name: "Unity.Licensing.Client", commandLine: "x" }) === null);
  check("无关进程返回 null", mod.classifyProcess({ pid: 400, name: "notepad.exe", commandLine: "" }) === null);

  const serverProc = mod.classifyProcess({
    pid: 500, name: "gamedev-mcp-server.exe", commandLine: "gamedev-mcp-server.exe --port=8080 --client-transport=stdio",
  });
  check("已知 MCP 服务器进程被识别", serverProc?.kind === "mcp-server", serverProc?.kind);
  check("服务器进程带出 bridgeId", serverProc?.bridgeId === "ivanmurzak-unity-mcp", serverProc?.bridgeId);

  // ── command-line evidence ───────────────────────────────────────────────
  const withEnv = mod.classifyProcess({
    pid: 600, name: "Unity.exe",
    commandLine: 'Unity.exe -projectPath "D:/p" -UNITY_MCP_CLOUD_URL=http://localhost:8080 -UNITY_MCP_TOKEN=xxx',
  });
  const envEvidence = mod.detectCommandLineEvidence(withEnv);
  check("从编辑器命令行识别 MCP 参数", envEvidence.length === 1, envEvidence.map((e) => e.bridgeId).join(","));
  check("证据点名具体参数", envEvidence[0]?.evidence.some((e) => e.includes("UNITY_MCP_CLOUD_URL")), envEvidence[0]?.evidence.join(" | "));
  check("从值里取出端口", envEvidence[0]?.port === 8080, String(envEvidence[0]?.port));

  const uvServer = mod.classifyProcess({ pid: 700, name: "python.exe", commandLine: "uv run python -m unity_mcp server.py --port 23456" });
  check("uv run 形态不被误分类为编辑器", uvServer === null || uvServer.kind !== "editor");
  const uvEvidence = mod.detectCommandLineEvidence({ raw: "uv run python -m unity_mcp server.py --port 23456", args: mod.parseCommandLine("uv run --port 23456").args });
  check("识别 uv run 的 MCP 服务器", uvEvidence.some((e) => e.bridgeId === "coplaydev-unity-mcp"), uvEvidence.map((e) => e.bridgeId).join(","));

  const noise = mod.detectCommandLineEvidence({ raw: "Unity.exe -projectPath D:/p -batchmode", args: mod.parseCommandLine("Unity.exe -projectPath D:/p -batchmode").args });
  check("普通编辑器命令行不产生 MCP 证据", noise.length === 0, noise.map((e) => e.bridgeId).join(","));
  check("空命令行不产生证据", mod.detectCommandLineEvidence({ raw: "", args: {} }).length === 0);

  // Port must come from the line, never from a scan.
  const noPort = mod.detectCommandLineEvidence({ raw: "Unity.exe -UNITY_MCP_TOKEN=abc", args: mod.parseCommandLine("Unity.exe -UNITY_MCP_TOKEN=abc").args });
  check("命令行没写端口时 port 为 null", noPort[0]?.port === null, String(noPort[0]?.port));

  // ── project evidence ────────────────────────────────────────────────────
  const fakeFiles = {
    "D:/p1/Packages/manifest.json": JSON.stringify({ dependencies: { "com.ivanmurzak.unity.mcp": "0.51.6" } }),
    "D:/p1/UserSettings/AI-Game-Developer-Config.json": "{}",
    "D:/p2/Packages/manifest.json": JSON.stringify({ dependencies: { "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity": "x" } }),
    "D:/p3/Packages/manifest.json": JSON.stringify({ dependencies: { "com.vrchat.worlds": "3.5.0" } }),
  };
  const readText = (p) => (Object.hasOwn(fakeFiles, p) ? fakeFiles[p] : null);
  const exists = (p) => Object.hasOwn(fakeFiles, p);

  const p1 = mod.detectProjectEvidence("D:/p1", readText, exists);
  check("manifest 包 id 命中", p1.some((e) => e.bridgeId === "ivanmurzak-unity-mcp"), p1.map((e) => e.bridgeId).join(","));
  check("配置文件命中也被记为证据", p1[0]?.evidence.some((e) => e.includes("AI-Game-Developer-Config")), p1[0]?.evidence.join(" | "));

  const p2 = mod.detectProjectEvidence("D:/p2", readText, exists);
  check("manifest git URL 命中 CoplayDev", p2.some((e) => e.bridgeId === "coplaydev-unity-mcp"), p2.map((e) => e.bridgeId).join(","));

  const p3 = mod.detectProjectEvidence("D:/p3", readText, exists);
  check("只有 VRCSDK 的项目不报 MCP", p3.length === 0, p3.map((e) => e.bridgeId).join(","));
  check("不存在的项目路径安全", mod.detectProjectEvidence("", readText, exists).length === 0);

  // ── lockfile ────────────────────────────────────────────────────────────
  const pidBytes = new Uint8Array(4);
  new DataView(pidBytes.buffer).setUint32(0, 12345, true);
  check("lockfile 解出 PID", mod.decodeLockfilePid(pidBytes) === 12345);
  check("0 字节视为无 PID", mod.decodeLockfilePid(new Uint8Array(0)) === null);
  check("4 字节 0 视为无 PID", mod.decodeLockfilePid(new Uint8Array([0, 0, 0, 0])) === null);

  const realLock = path.join(REAL_PROJECT, "Temp", "UnityLockfile");
  if (fs.existsSync(realLock)) {
    const bytes = new Uint8Array(fs.readFileSync(realLock));
    check(`真实 lockfile 解码安全（${bytes.length} 字节）`, true, `PID=${mod.decodeLockfilePid(bytes)}`);
  }

  // ── the port scanner must be gone ───────────────────────────────────────
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "unity-status.js"), "utf8");
  // Strip comments first: the file EXPLAINS why port scanning is wrong, and
  // matching that prose would flag the documentation rather than the code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  check("代码里没有端口区间常量", !/20000\s*,\s*29999/.test(code));
  check("代码里没有 judgePort", !/judgePort/.test(code));
  check("代码里没有端口扫描调用", !/NetTCPConnection|Get-NetTCP/i.test(code));
  check("注释里写明了为何不扫描端口", /proves nothing|不能证明|猜/.test(source));

  // ── report tone ─────────────────────────────────────────────────────────
  const empty = mod.renderReport({
    processes: [], projects: [], commandEvidence: [], cliDetected: false,
  });
  check("无结果时明确说没找到", /没有找到确凿的 MCP 证据/.test(empty));
  check("说明这不是「没有」", /这不等于没有/.test(empty));
  check("给出下一步命令", /Get-CimInstance Win32_Process/.test(empty), "应告诉 agent 自己看命令行");
  check("提到项目配置文件", /AI-Game-Developer-Config\.json/.test(empty));
  check("提到 manifest 检查", /Packages\/manifest\.json/.test(empty));
  check("提到可用 MCP 参数启动", /--headless/.test(empty));
  check("提到可以直接问用户", /问用户/.test(empty));

  const withEvidence = mod.renderReport({
    processes: [editorProc, hubProc, serverProc],
    projects: [{ path: "D:/proj/game", editorVersion: "2022.3.22f1c1", lockedByPid: 200, bridgeEvidence: [{ label: "IvanMurzak/Unity-MCP", evidence: ["manifest 含 com.ivanmurzak.unity.mcp"] }] }],
    commandEvidence: [{ pid: 200, label: "IvanMurzak/Unity-MCP", evidence: ["参数 UNITY_MCP_CLOUD_URL"], port: 8080 }],
    cliDetected: true,
  });
  check("有证据时标明来源", /命令行证据/.test(withEvidence));
  check("端口被标为「指令行声明的」", /该命令行声明端口 8080/.test(withEvidence));
  check("强调不是猜测", /不是猜测/.test(withEvidence));
  check("说明 token 不在本工具范围", /token 不在本工具范围内/.test(withEvidence));
  check("报告不含凭据", !/Bearer|Authorization/.test(withEvidence));
  check("提示 unity-mcp-cli status", /unity-mcp-cli/.test(withEvidence));

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
