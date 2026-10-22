/**
 * Unity runtime discovery — EVIDENCE from process command lines and project
 * files, not from scanning ports.
 *
 * WHY NOT PORT SCANNING: an open port proves nothing. A listening socket says
 * "something is listening", and guessing that a number in 20000..29999 implies
 * MCP is a coin flip presented as a finding. It also costs a full
 * `Get-NetTCPConnection` sweep. So the port is only ever reported when a
 * command line NAMES it — evidence chained to a process that says what it is.
 *
 * WHAT COUNTS AS EVIDENCE:
 *   command line template   a process whose arguments match a known MCP
 *                           launcher shape (Unity-MCP env vars / args, the
 *                           `gamedev-mcp-server` binary, `uv run` + a
 *                           unity-mcp server script)
 *   project manifest        `Packages/manifest.json` naming an MCP package
 *   project config          the per-project file a bridge writes
 *                           (`UserSettings/AI-Game-Developer-Config.json`)
 *
 * FINDING NOTHING IS A RESULT, NOT A FAILURE. The report says so explicitly and
 * tells the agent what to do next — launch the project with MCP arguments,
 * read the config file, or parse the command line itself. This layer points;
 * it does not pretend to be exhaustive.
 */

/**
 * Command-line / environment templates per known bridge.
 *
 * Each entry lists the argument names and environment prefixes that identify
 * it. Matching is on the parsed flag map plus the raw string (env vars are
 * exported by the CLI onto the editor's command line, so they appear inline).
 */
export const BRIDGE_TEMPLATES = [
  {
    id: "ivanmurzak-unity-mcp",
    label: "IvanMurzak/Unity-MCP",
    packageIds: ["com.ivanmurzak.unity.mcp"],
    // The editor is launched with these; the standalone server is this binary.
    // These are DEDICATED spellings: nobody else uses a flag called
    // UNITY_MCP_TOKEN, so a match on one of them is real evidence.
    argNames: ["UNITY_MCP_CLOUD_URL", "UNITY_MCP_HOST", "UNITY_MCP_TOKEN", "UNITY_MCP_TRANSPORT",
      "UNITY_MCP_KEEP_CONNECTED", "UNITY_MCP_AUTH_OPTION", "UNITY_MCP_START_SERVER", "UNITY_MCP_TOOLS"],
    /**
     * Generic words: `--url`, `--token`, `--auth` are used by countless programs.
     * A crashpad handler alone carries `--url=https://f.a.k/e`, and matching that
     * as "the Unity MCP server said so" is a false positive — it happened on this
     * very machine, reported as `PID 63584 → IvanMurzak/Unity-MCP`.
     *
     * So a generic alias is only counted when a DEDICATED marker also matches the
     * same process. Weak evidence never stands alone.
     */
    argAliases: ["UNITY_MCP_CONNECTION_MODE"],
    genericAliases: ["url", "token", "auth", "clientTransport"],
    executableNames: ["gamedev-mcp-server", "gamedev-mcp-server.exe"],
    configFiles: ["UserSettings/AI-Game-Developer-Config.json"],
  },
  {
    id: "coplaydev-unity-mcp",
    label: "CoplayDev/unity-mcp",
    packageIds: ["com.coplaydev.unity-mcp"],
    // Its server is a Python process: `uv run ... server.py`.
    rawPatterns: [/\buv\s+run\b.*(unity[-_]?mcp|MCPForUnity)/i, /\bunity[-_]mcp\b.*server\.py/i],
    executableNames: [],
    configFiles: [],
    // Installed as a git dependency in the manifest rather than a registry package.
    manifestPatterns: [/github\.com\/CoplayDev\/unity-mcp/i],
  },
  {
    id: "alcomd3",
    label: "ALCOMD3（VRChat 包管理器）",
    packageIds: [],
    executableNames: ["alcomd3", "alcomd3.exe", "ALCOMD3.exe", "alcomd"],
    configFiles: [],
    rawPatterns: [/\balcomd3?\b/i],
  },
];

/**
 * Split a command line into tokens, honouring quotes.
 * @param raw - the command line.
 */
function tokenize(raw) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Parse `--flag value`, `-flag value`, `--flag=value` and `-flag=value`.
 *
 * A bare `--` separator is skipped rather than consumed as a value: Unity Hub
 * is observed to emit `"--" "--silent" "--" "-projectPath" "<path>"`, and a
 * naive parser would attach `--` to the preceding flag.
 *
 * @param commandLine - the full command line.
 */
export function parseCommandLine(commandLine) {
  const raw = String(commandLine ?? "");
  const args = {};
  const tokens = tokenize(raw);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("-")) continue;
    const key = token.replace(/^-+/, "");
    if (key.length === 0) continue; // bare `--`
    const inline = key.indexOf("=");
    if (inline > 0) {
      args[key.slice(0, inline)] = key.slice(inline + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next === "--" || next.startsWith("-")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index++;
  }
  return { raw, args, tokens };
}

/**
 * Normalize a `-projectPath` value into a plain path string.
 *
 * Unity Hub itself writes doubled separators: the real command line on this
 * machine carries `-projectPath "E:\\Users\\...\\gitui-merge-fixture"`. That is a
 * legal Windows path (extra separators are ignored by the filesystem) but it is
 * NOT what a user types, and echoing it back invites the model to copy the doubled
 * form into a command or a config. Collapse runs of separators, unify to forward
 * slashes, and drop the trailing one.
 *
 * A UNC share (`\\server\share`) keeps its leading double backslash: collapsing
 * that would change which host is addressed.
 *
 * @param value - the raw argument value.
 * @returns the normalized path, or null when there is nothing usable.
 */
function normalizeProjectPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;

  // Remember UNC-ness before collapsing, then restore it.
  const isUnc = /^\\\\[^\\]/.test(value);

  let path = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (isUnc) path = `/${path}`; // "/server/share" → "//server/share"
  path = path.replace(/\/+$/, "");

  return path.length === 0 ? null : path;
}

/**
 * Classify one running process.
 *
 * The licensing client (`Unity.Licensing.Client.exe`) begins with "unity" but
 * is not an editor, so the name tests are exact rather than prefix-based.
 *
 * @param process - `{ pid, name, executablePath, commandLine }`.
 */
export function classifyProcess(process) {
  const name = String(process?.name ?? "");
  const lower = name.toLowerCase();
  const rawCommandLine = String(process?.commandLine ?? "");
  // A higher-integrity process is enumerable but its CommandLine comes back null
  // or empty (measured: `lsass`). That is not "no evidence" — it is "opaque", and
  // the reporter must say so instead of guessing there is no MCP server.
  const commandLineUnavailable = rawCommandLine.length === 0;
  const parsed = parseCommandLine(rawCommandLine);

  if (lower.startsWith("unity hub")) {
    const result = { kind: "hub", pid: process.pid, name, projectPath: normalizeProjectPath(parsed.args.projectPath), args: parsed.args, raw: parsed.raw };
    if (commandLineUnavailable) result.commandLineUnavailable = true;
    return result;
  }
  if (lower === "unity.exe" || lower === "unity") {
    const result = {
      kind: "editor",
      pid: process.pid,
      name,
      executablePath: process.executablePath ?? null,
      projectPath: normalizeProjectPath(parsed.args.projectPath),
      batchMode: parsed.args.batchmode === true || parsed.args.batchmode === "true",
      args: parsed.args,
      raw: parsed.raw,
    };
    if (commandLineUnavailable) result.commandLineUnavailable = true;
    return result;
  }
  for (const bridge of BRIDGE_TEMPLATES) {
    const base = name.replace(/\.exe$/i, "");
    if (bridge.executableNames.some((exe) => exe.replace(/\.exe$/i, "").toLowerCase() === base.toLowerCase())) {
      const result = { kind: "mcp-server", pid: process.pid, name, bridgeId: bridge.id, projectPath: null, args: parsed.args, raw: parsed.raw };
      if (commandLineUnavailable) result.commandLineUnavailable = true;
      return result;
    }
  }
  return null;
}

/**
 * Match a process command line against the bridge templates.
 *
 * Returns EVERY template that matches, with the specific evidence that matched,
 * because "this claimed MCP on this port" is only useful when the claim is
 * named rather than inferred.
 *
 * @param process - a classified process carrying `raw` and `args`.
 * @returns matched bridges with their evidence and any port the line names.
 */
export function detectCommandLineEvidence(process) {
  const raw = String(process?.raw ?? "");
  const args = process?.args ?? {};
  if (raw.length === 0) return [];

  const matches = [];
  for (const bridge of BRIDGE_TEMPLATES) {
    const evidence = [];

    // Dedicated spellings: strong on their own.
    for (const name of bridge.argNames ?? []) {
      if (Object.hasOwn(args, name)) evidence.push(`参数 ${name}`);
    }
    for (const alias of bridge.argAliases ?? []) {
      if (Object.hasOwn(args, alias)) evidence.push(`参数 ${alias}`);
    }
    for (const name of bridge.executableNames ?? []) {
      // A matched executable is evidence even when no flag is present.
      if (raw.toLowerCase().includes(name.replace(/\.exe$/i, "").toLowerCase())) evidence.push(`可执行文件 ${name}`);
    }
    for (const pattern of bridge.rawPatterns ?? []) {
      if (pattern.test(raw)) evidence.push(`命令行匹配 /${pattern.source}/`);
    }

    // Generic words are only counted ALONGSIDE a dedicated marker. Countless
    // programs take `--url` (a crashpad handler's `--url=https://f.a.k/e` was
    // reported as "IvanMurzak/Unity-MCP" on this very machine), and a lone generic
    // flag must not turn into a confident identification.
    if (evidence.length > 0) {
      for (const generic of bridge.genericAliases ?? []) {
        if (Object.hasOwn(args, generic)) evidence.push(`参数 ${generic}（通用词，已由专属标记佐证）`);
      }
    }

    if (evidence.length === 0) continue;

    // A port only counts when the SAME command line named it.
    const port = extractPort(args, raw);
    matches.push({ bridgeId: bridge.id, label: bridge.label, evidence, port });
  }
  return matches;
}

/**
 * Pull a port out of the arguments, if the line names one.
 *
 * Handles the shapes these launchers actually use: `--port 8080`, `port=8080`,
 * and a URL such as `http://localhost:8080`.
 */
function extractPort(args, raw) {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    if (/port$/i.test(key) && /^\d{2,5}$/.test(value)) return Number(value);
    const url = /^https?:\/\/[^\s]*?:(\d{2,5})/.exec(value);
    if (url !== null) return Number(url[1]);
  }
  const inlineUrl = /https?:\/\/[^\s"]*?:(\d{2,5})/.exec(raw);
  if (inlineUrl !== null) return Number(inlineUrl[1]);
  const inlinePort = /\b(?:--port=|port=|--port\s+)(\d{2,5})\b/.exec(raw);
  return inlinePort === null ? null : Number(inlinePort[1]);
}

/**
 * Decode a Unity lockfile's PID. A 0-byte file is the placeholder an editor
 * leaves when it is not holding the project, so "no pid" is normal.
 * @param bytes - the file's bytes.
 */
export function decodeLockfilePid(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = view.getUint32(0, true);
  return pid === 0 ? null : pid;
}

/**
 * Read a project's manifest and config for bridge evidence.
 *
 * @param readText - `(absolutePath) => string | null`.
 * @param exists - `(absolutePath) => boolean`.
 * @param projectPath - the project root.
 * @returns evidence entries for this project.
 */
export function detectProjectEvidence(projectPath, readText, exists) {
  const found = [];
  if (typeof projectPath !== "string" || projectPath.length === 0) return found;

  const manifestRel = "Packages/manifest.json";
  const manifestPath = `${projectPath}/${manifestRel}`;
  let manifest = null;
  if (exists(manifestPath)) {
    manifest = (() => {
      try {
        return readText(manifestPath);
      } catch {
        return null;
      }
    })();
  }

  for (const bridge of BRIDGE_TEMPLATES) {
    const evidence = [];
    for (const id of bridge.packageIds ?? []) {
      if (manifest !== null && manifest.includes(id)) evidence.push(`manifest 含 ${id}`);
    }
    for (const pattern of bridge.manifestPatterns ?? []) {
      if (manifest !== null && pattern.test(manifest)) evidence.push(`manifest 匹配 /${pattern.source}/`);
    }
    for (const rel of bridge.configFiles ?? []) {
      if (exists(`${projectPath}/${rel}`)) evidence.push(`存在 ${rel}`);
    }
    if (evidence.length > 0) found.push({ bridgeId: bridge.id, label: bridge.label, evidence });
  }
  return found;
}

/**
 * Compose the model-facing report.
 *
 * The tone rule: never upgrade a possibility into a fact, and when nothing is
 * found, say so AND say what the agent should do next.
 */
/**
 * Read the Unity license's validity window.
 *
 * WHY THIS IS HERE: an expired license makes Unity refuse to open a project, fail
 * to build, and print errors that look like project problems. It is one of the
 * most common ways a VRChat creator gets stuck, and nothing about the symptoms
 * points at licensing — so the probe reports it rather than leaving the user to
 * discover it after an hour of debugging.
 *
 * Only the DATE fields are read. The `.ulf` file also contains license keys; the
 * tool never touches, echoes, or stores them.
 *
 * @param readText - `(absolutePath) => string | null`.
 * @param exists - `(absolutePath) => boolean`.
 * @param now - current time, injected so the caller's clock is explicit.
 * @returns `{ state, stopDate, daysLeft }`; `state` is `missing` | `perpetual` |
 *   `active` | `expiring` | `expired`.
 */
export function inspectLicense({ programData, exists, readText, now = Date.now() }) {
  // Unity stores the license machine-wide, not per user: ProgramData is the place
  // every account reads, which matches how a license activated for one user still
  // serves another.
  const file = `${programData}\\Unity\\Unity_lic.ulf`;
  if (!exists(file)) return { state: "missing", stopDate: null, daysLeft: null };

  const text = readText(file);
  if (text === null) return { state: "missing", stopDate: null, daysLeft: null };

  // A Date-less license is perpetual (an older serial-activated install).
  const stop = /<StopDate\s+Value="([^"]+)"/.exec(text);
  if (stop === null) return { state: "perpetual", stopDate: null, daysLeft: null };

  const parsed = Date.parse(stop[1]);
  if (Number.isNaN(parsed)) return { state: "perpetual", stopDate: null, daysLeft: null };

  const daysLeft = (parsed - now) / 86400000;
  if (daysLeft < 0) return { state: "expired", stopDate: stop[1], daysLeft };
  // Warn a week out: activation needs a browser round trip, so it must not be
  // discovered mid-task.
  if (daysLeft < 7) return { state: "expiring", stopDate: stop[1], daysLeft };
  return { state: "active", stopDate: stop[1], daysLeft };
}

export function renderReport(input) {
  const { processes, projects, commandEvidence, cliDetected, diagnostics, license } = input;
  const lines = [];

  const editors = processes.filter((p) => p.kind === "editor");
  const hubs = processes.filter((p) => p.kind === "hub");
  const servers = processes.filter((p) => p.kind === "mcp-server");

  // ── what is running ───────────────────────────────────────────────────
  //
  // A zero here is NOT proof that nothing runs. Windows hides another user's
  // processes, and even one this user can see may have its CommandLine withheld
  // when it runs at a higher integrity level (measured: `lsass` is enumerable but
  // its CommandLine reads back null). So the report states what was OBSERVED and
  // names the two reasons a zero is inconclusive.
  if (editors.length === 0 && hubs.length === 0 && servers.length === 0) {
    lines.push("没有发现 Unity 编辑器、Unity Hub 或已知的 MCP 服务器进程。");
  } else {
    lines.push(
      `正在运行：编辑器 ${editors.length} 个，Hub ${hubs.length} 个，已知 MCP 服务器 ${servers.length} 个。`,
    );
  }

  // Processes whose CommandLine could not be read: visible, but opaque.
  const opaque = processes.filter((p) => p.commandLineUnavailable === true);
  if (opaque.length > 0) {
    lines.push("");
    lines.push(
      `⚠️ ${opaque.length} 个进程的启动参数读不到（${opaque.map((p) => p.pid).join(", ")}）。` +
        "这通常意味着它们以更高权限运行——本工具的进程信息不完整，别据此断定「没有 MCP」。",
    );
  }

  for (const editor of editors) {
    lines.push("");
    lines.push(`◆ Unity 编辑器 · PID ${editor.pid}`);
    lines.push(`  项目：${editor.projectPath ?? "（命令行未带 -projectPath）"}`);
    if (editor.batchMode) lines.push("  无头模式（--batchmode）");
  }
  // A Hub spawns several processes (crashpad handler, GPU process, ...) and only
  // the launcher carries `-projectPath`. Listing just that one under a header of
  // "Hub 4 个" reads as missing data, so the rest are accounted for explicitly.
  let hubWithoutPath = 0;
  for (const hub of hubs) {
    if (hub.projectPath === null) {
      hubWithoutPath++;
      continue;
    }
    lines.push("");
    lines.push(`◆ Unity Hub · PID ${hub.pid}`);
    lines.push(`  最近的项目参数：${hub.projectPath}`);
  }
  if (hubWithoutPath > 0) {
    lines.push("");
    lines.push(
      `（另有 ${hubWithoutPath} 个 Unity Hub 辅助进程没有 \`-projectPath\`：` +
        "Hub 会派生崩溃上报、渲染等子进程，它们不指向任何项目，属正常现象。）",
    );
  }
  for (const server of servers) {
    lines.push("");
    lines.push(`◆ MCP 服务器进程 · PID ${server.pid}（${server.bridgeId}）`);
  }

  // ── command-line evidence ─────────────────────────────────────────────
  if (commandEvidence.length > 0) {
    lines.push("");
    lines.push("命令行证据（进程自己声明了 MCP 相关参数）：");
    for (const entry of commandEvidence) {
      lines.push(`  PID ${entry.pid} → ${entry.label}`);
      for (const item of entry.evidence) lines.push(`    · ${item}`);
      if (entry.port !== null) {
        lines.push(`    · 该命令行声明端口 ${entry.port} —— 这是**可以据此去连的依据**，不是猜测`);
      } else {
        lines.push("    · 命令行没有指明端口，端到端要自己确认");
      }
    }
  }

  // ── license ───────────────────────────────────────────────────────────
  //
  // Reported BEFORE the projects, because an expired license changes what every
  // following line means: Unity will refuse to open, builds fail, and the errors
  // point at the project rather than at licensing.
  if (license !== undefined) {
    lines.push("");
    if (license.state === "expired") {
      lines.push(`◆ Unity 许可证：**已过期**（${String(license.stopDate ?? "").slice(0, 10)} 到期）`);
      lines.push(
        "  这会让 Unity 打不开项目、构建失败，而报错通常指向项目本身。先续期再排查别的：" +
          "Unity Hub → 设置 → 许可证 → 激活（需要登录 Unity 账号）。",
      );
    } else if (license.state === "expiring") {
      lines.push(
        `◆ Unity 许可证：${license.daysLeft < 1 ? "不到一天" : `约 ${Math.floor(license.daysLeft)} 天`}后到期` +
          `（${String(license.stopDate ?? "").slice(0, 10)}）`,
      );
      lines.push("  提前续期，不要等到任务做到一半才发现打不开项目。");
    } else if (license.state === "active") {
      lines.push(`◆ Unity 许可证：有效至 ${String(license.stopDate ?? "").slice(0, 10)}`);
    } else if (license.state === "perpetual") {
      lines.push("◆ Unity 许可证：无到期日（永久许可）");
    } else {
      lines.push("◆ Unity 许可证：**本机没找到许可证文件**");
      lines.push(
        "  这不等于没激活——企业/浮动许可或较新的激活方式可能不写这个文件。" +
          "若 Unity 打不开项目，先查 Hub 里的许可证状态，再怀疑项目。",
      );
    }
  }

  // ── projects ──────────────────────────────────────────────────────────
  if (projects.length > 0) {
    lines.push("");
    lines.push("已知 Unity 项目：");
    for (const project of projects) {
      lines.push(`  ${project.path}`);
      if (project.editorVersion !== null) lines.push(`    编辑器版本：${project.editorVersion}`);
      lines.push(
        `    锁定：${project.lockedByPid === null ? "未锁定" : `被 PID ${project.lockedByPid} 占用`}`,
      );
      if (project.bridgeEvidence.length > 0) {
        for (const bridge of project.bridgeEvidence) {
          lines.push(`    ${bridge.label}：${bridge.evidence.join("；")}`);
        }
      } else {
        lines.push("    项目内未发现 MCP 桥的包或配置文件");
      }
    }
  }

  // ── what to do when nothing was found ─────────────────────────────────
  const hasEvidence = commandEvidence.length > 0 || projects.some((p) => p.bridgeEvidence.length > 0);
  lines.push("");
  if (!hasEvidence) {
    lines.push("**没有找到确凿的 MCP 证据。** 这不等于没有，只等于「从进程和项目文件里没看到」。");
    lines.push("接下来该你自己动手，任选：");
    lines.push("  · 读进程启动参数：`Get-CimInstance Win32_Process` 的 CommandLine 字段，逐条看");
    lines.push("  · 读项目配置：Unity-MCP 写在 `UserSettings/AI-Game-Developer-Config.json`");
    lines.push("  · 读 `Packages/manifest.json`，看是否装了 `com.ivanmurzak.unity.mcp` 之类的包");
    lines.push("  · 用 MCP 参数启动项目：`unity-mcp-cli open <项目> --headless`，再 `wait-for-ready`");
    lines.push("  · 需要时直接问用户端点和 token，不要从别处猜");
  } else {
    lines.push("以上证据都来自进程命令行或项目文件本身，不是端口猜测。");
    lines.push("**token 不在本工具范围内**——去该项目的 MCP 配置里取，或问用户。");
  }

  if (cliDetected) {
    lines.push("");
    lines.push("检测到 `unity-mcp-cli`：它的 `status <项目路径>` 会给出更细的连接状态，需要时可用。");
  }

  // A "nothing found" answer must carry the EVIDENCE for it, not just the verdict.
  // Without this the tool once said "no Unity processes" while four were running,
  // and there was no way to tell why. The numbers make a silent zero visible.
  if (diagnostics !== undefined) {
    lines.push("");
    lines.push(
      `探查细节：退出码 ${diagnostics.exitCode ?? "null"} · stdout ${diagnostics.stdoutChars} 字符 · ` +
        (diagnostics.timedOut ? "已超时" : "未超时") +
        (diagnostics.aborted ? " · 已中止" : ""),
    );
    if (diagnostics.rawProcs === 0 || diagnostics.rawProcs === 0.0) {
      lines.push(
        "⚠️ shell 成功返回，但进程列表为空——这可能是探测环境的限制，而不是真的没有 Unity。" +
          "请自行用 `Get-CimInstance Win32_Process` 复核。",
      );
    }
    if (typeof diagnostics.stderrText === "string" && diagnostics.stderrText.trim().length > 0) {
      lines.push(`stderr：${diagnostics.stderrText.trim().slice(0, 200)}`);
    }
  }

  return lines.join("\n");
}
