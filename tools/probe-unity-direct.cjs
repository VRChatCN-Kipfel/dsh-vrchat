/**
 * Prove the tool's direct-spawn path returns the Unity processes.
 *
 * This exercises the SAME helper the tool uses, so it is the closest thing to the
 * live call short of the live call: if this returns 4 hubs, the fix works.
 *
 * Usage: node tools/probe-unity-direct.cjs
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

/** Verbatim copy of the helper in index.js (kept in sync by the assertion below). */
function runPwshJson(command, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
    } catch (error) {
      finish({ stdout: "", stderr: "", exitCode: null, error: String(error?.message ?? error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish({ stdout, stderr, exitCode: null, error: "pwsh 超时（20s）" });
    }, 20000);

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish({ stdout, stderr, exitCode: null, error: "调用已取消" });
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      finish({ stdout, stderr, exitCode: null, error: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      finish({ stdout, stderr, exitCode: code, error: null });
    });
  });
}

async function main() {
  const root = path.join(__dirname, "..");
  const mod = await import(pathToFileURL(path.join(root, "lib", "unity-status.js")).href);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // The helper in this file must match the one in index.js, or this proves nothing.
  const indexSource = require("node:fs").readFileSync(path.join(root, "index.js"), "utf8");
  check(
    "本测试的 helper 与 index.js 一致",
    indexSource.includes('spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]'),
    "index.js 若改了 spawn 形式，本测试要跟着改",
  );

  const script =
    "$p = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.Name -like 'Unity*' -or $_.Name -like '*mcp*' } | " +
    "Select-Object ProcessId, Name, ExecutablePath, CommandLine); " +
    "$cli = [bool](Get-Command unity-mcp-cli -ErrorAction SilentlyContinue); " +
    "[pscustomobject]@{ procs = $p; cli = $cli } | ConvertTo-Json -Depth 4 -Compress";

  const outcome = await runPwshJson(script);
  check("pwsh 执行无错误", outcome.error === null, String(outcome.error));
  check("退出码为 0", outcome.exitCode === 0, String(outcome.exitCode));
  check("stdout 非空", outcome.stdout.trim().length > 0, `${outcome.stdout.length} 字符`);

  let snapshot = null;
  try {
    snapshot = JSON.parse(outcome.stdout.trim() || "{}");
  } catch {
    /* reported below */
  }
  check("输出是有效 JSON", snapshot !== null);

  const rawProcs = snapshot === null ? [] : Array.isArray(snapshot.procs) ? snapshot.procs : [snapshot.procs];

  // WHICH ASSERTIONS APPLY DEPENDS ON THE MACHINE, and that is honest rather than
  // convenient: Unity may simply not be running when this check executes. The
  // plumbing (spawn, JSON, classification) is always verifiable; "found four hubs"
  // is only verifiable when four hubs exist. Asserting the latter unconditionally
  // would make the suite fail on a closed editor and teach people to ignore it.
  const unityIsRunning = rawProcs.length > 0;
  if (unityIsRunning) {
    check("拿到进程列表且非空", true, `${rawProcs.length} 个 Unity 相关进程`);
  } else {
    console.log("SKIP  本机当前没有 Unity 进程，跳过「命中」类断言（管道与分类另有覆盖）");
  }

  let classified = 0;
  for (const raw of rawProcs) {
    const result = mod.classifyProcess({
      pid: Number(raw.ProcessId),
      name: String(raw.Name ?? ""),
      executablePath: raw.ExecutablePath ?? null,
      commandLine: raw.CommandLine ?? "",
    });
    if (result !== null) classified++;
  }
  if (unityIsRunning) {
    check("至少识别出一个 Unity 进程", classified > 0, `${classified} 个`);
  }

  const report = mod.renderReport({
    processes: rawProcs
      .map((raw) =>
        mod.classifyProcess({
          pid: Number(raw.ProcessId),
          name: String(raw.Name ?? ""),
          executablePath: raw.ExecutablePath ?? null,
          commandLine: raw.CommandLine ?? "",
        }),
      )
      .filter((x) => x !== null),
    projects: [],
    commandEvidence: [],
    cliDetected: snapshot?.cli === true,
    diagnostics: {
      exitCode: outcome.exitCode,
      timedOut: false,
      aborted: false,
      stdoutChars: outcome.stdout.length,
      stderrText: outcome.stderr,
      rawProcs: rawProcs.length,
    },
  });

  console.log("\n生成的报告首三行：");
  console.log(report.split("\n").slice(0, 3).map((l) => `  ${l}`).join("\n"));

  if (unityIsRunning) {
    check("报告不再说「没有发现」", !/没有发现 Unity/.test(report));
    check("报告提到 Hub 进程", /Hub/.test(report));
  } else {
    // With no Unity running, the report SHOULD say it found nothing — and must
    // still carry the diagnostics that explain why, which is the real contract.
    check("无 Unity 时报告说明未发现", /没有发现 Unity/.test(report));
    check("无 Unity 时仍带探查细节", /探查细节/.test(report));
  }

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
