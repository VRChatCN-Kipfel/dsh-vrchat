/**
 * Verify generic flags alone never identify a bridge.
 *
 * A crashpad handler carries `--url=https://f.a.k/e`. Matching that as "the Unity
 * MCP server said so" produced `PID 63584 → IvanMurzak/Unity-MCP` on this machine —
 * a confident claim about an MCP server that was not there. Generic words must
 * never stand alone.
 *
 * Usage: node tools/evidence-falsepositive-check.cjs
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "unity-status.js")).href);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  /** Build a classified process from a raw command line. */
  const probe = (commandLine) => {
    const parsed = mod.parseCommandLine(commandLine);
    return mod.detectCommandLineEvidence({ raw: commandLine, args: parsed.args });
  };

  // ── the exact false positive from this machine ─────────────────────────
  const crashpad =
    '"D:\\Program Files\\Unity Hub\\Unity Hub.exe" --type=crashpad-handler ' +
    "--user-data-dir=C:\\Users\\x\\AppData\\Roaming\\UnityHub /prefetch:4 --no-rate-limit " +
    "--monitor-self-annotation=ptype=crashpad-handler --database=C:\\x\\Crashpad " +
    "--url=https://f.a.k/e --annotation=_productName=UnityHub --annotation=_version=3.14.4";
  check("crashpad 命令行不再被认成 MCP", probe(crashpad).length === 0, JSON.stringify(probe(crashpad)));

  // The same trap with other generic flags.
  for (const generic of [
    'app.exe --url=https://example.com',
    'app.exe --token=abc123',
    'app.exe --auth=basic',
    'app.exe --url=https://x --token=y --auth=z',
  ]) {
    check(`通用词不单独成立: ${generic.slice(0, 34)}`, probe(generic).length === 0);
  }

  // ── but a dedicated marker still counts, with generic ones as support ───
  const real = probe('Unity.exe -projectPath "D:/p" -UNITY_MCP_CLOUD_URL=http://localhost:8080 -url=x');
  check("专属标记仍能识别", real.length === 1, JSON.stringify(real.map((m) => m.bridgeId)));
  check("专属 + 通用都记入证据", real[0]?.evidence.length >= 2, real[0]?.evidence.join(" | "));
  check("通用词被标注为已佐证", real[0]?.evidence.some((e) => /通用词.*佐证/.test(e)), real[0]?.evidence.join(" | "));

  const onlyDedicated = probe("Unity.exe -UNITY_MCP_TOKEN=abc");
  check("只有专属标记也成立", onlyDedicated.length === 1, JSON.stringify(onlyDedicated.map((m) => m.bridgeId)));
  check("只有专属时不出现通用词标注", !onlyDedicated[0]?.evidence.some((e) => /通用词/.test(e)));

  // ── unrelated lines stay unrelated ─────────────────────────────────────
  check("普通编辑器命令行无证据", probe('Unity.exe -projectPath "D:/p" -batchmode').length === 0);
  check("空命令行无证据", probe("").length === 0);

  // ── the dedicated list must not contain generic words by accident ──────
  const GENERIC = new Set(["url", "token", "auth", "host", "port", "path", "mode"]);
  for (const bridge of mod.BRIDGE_TEMPLATES) {
    const leaked = [...(bridge.argNames ?? []), ...(bridge.argAliases ?? [])].filter((name) =>
      GENERIC.has(name.toLowerCase()),
    );
    check(`${bridge.id} 的强证据不含通用词`, leaked.length === 0, leaked.join(", ") || "none");
  }

  // Every bridge that declares generic aliases must ALSO declare a strong one,
  // or its generic list could never be used.
  for (const bridge of mod.BRIDGE_TEMPLATES) {
    if ((bridge.genericAliases ?? []).length === 0) continue;
    const strong =
      (bridge.argNames ?? []).length + (bridge.argAliases ?? []).length + (bridge.executableNames ?? []).length +
      (bridge.rawPatterns ?? []).length;
    check(`${bridge.id} 声明了通用词就必须有强证据`, strong > 0, `${strong} 个强证据`);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
