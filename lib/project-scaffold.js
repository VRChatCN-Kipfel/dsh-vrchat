/**
 * Scaffold a minimal VRChat Unity project on disk.
 *
 * WHY THIS EXISTS: an ALCOM GUI can create a project, but that ability lives only
 * inside the GUI process as Tauri IPC commands — there is no CLI entry. `vrc-get`
 * (the CLI half) has no create command at all: its 16 subcommands are install /
 * resolve / remove / reinstall / update / outdated / upgrade / downgrade / search /
 * repo / user-package / info / migrate / cache / completion / help. So an agent
 * asked to "make me a world" had no way to start one.
 *
 * WHAT IT WRITES is the `Blank` branch of vrc-get-gui's own `create_project`, plus
 * the package manifests taken verbatim from `vrc-get-gui/project-templates/`:
 *
 *     Assets/
 *     ProjectSettings/ProjectVersion.txt
 *     Packages/manifest.json        (36 Unity deps, identical for world and avatar)
 *     Packages/vpm-manifest.json    (the ONE line that differs: worlds vs avatars)
 *
 * It deliberately does NOT write `ProjectSettings.asset` or `InputManager.asset`.
 * Those are 25 KB and 27 KB of Unity-serialized YAML; writing them from here would
 * be a fabricated copy that no one can verify without opening Unity. Unity fills
 * them in on first open, and vrc-get-gui's own Blank template omits them too.
 *
 * It does not run Unity, vrc-get, or any network call. Installing the SDK is
 * `vrc-get resolve`, and the result says so explicitly.
 */
import fs from "node:fs";
import path from "node:path";

/** The Unity package set from vrc-get-gui/project-templates/worlds-2022.3.22f1. */
const UNITY_DEPS = {
  "com.unity.collab-proxy": "2.3.1",
  "com.unity.feature.development": "1.0.1",
  "com.unity.textmeshpro": "3.0.6",
  "com.unity.timeline": "1.7.5",
  "com.unity.ugui": "1.0.0",
  "com.unity.modules.ai": "1.0.0",
  "com.unity.modules.androidjni": "1.0.0",
  "com.unity.modules.animation": "1.0.0",
  "com.unity.modules.assetbundle": "1.0.0",
  "com.unity.modules.audio": "1.0.0",
  "com.unity.modules.cloth": "1.0.0",
  "com.unity.modules.director": "1.0.0",
  "com.unity.modules.imageconversion": "1.0.0",
  "com.unity.modules.imgui": "1.0.0",
  "com.unity.modules.jsonserialize": "1.0.0",
  "com.unity.modules.particlesystem": "1.0.0",
  "com.unity.modules.physics": "1.0.0",
  "com.unity.modules.physics2d": "1.0.0",
  "com.unity.modules.screencapture": "1.0.0",
  "com.unity.modules.terrain": "1.0.0",
  "com.unity.modules.terrainphysics": "1.0.0",
  "com.unity.modules.tilemap": "1.0.0",
  "com.unity.modules.ui": "1.0.0",
  "com.unity.modules.uielements": "1.0.0",
  "com.unity.modules.umbra": "1.0.0",
  "com.unity.modules.unityanalytics": "1.0.0",
  "com.unity.modules.unitywebrequest": "1.0.0",
  "com.unity.modules.unitywebrequestassetbundle": "1.0.0",
  "com.unity.modules.unitywebrequestaudio": "1.0.0",
  "com.unity.modules.unitywebrequesttexture": "1.0.0",
  "com.unity.modules.unitywebrequestwww": "1.0.0",
  "com.unity.modules.vehicles": "1.0.0",
  "com.unity.modules.video": "1.0.0",
  "com.unity.modules.vr": "1.0.0",
  "com.unity.modules.wind": "1.0.0",
  "com.unity.modules.xr": "1.0.0",
};

/**
 * The only difference between a World project and an Avatar project.
 * Verified by diffing both templates' manifests: identical 36 entries.
 */
const VPM_SDK = {
  world: "com.vrchat.worlds",
  avatar: "com.vrchat.avatars",
};

/** Unity versions VRChat SDK is actually bound to. 2022.3.22f1 is the 3.5.0+ one. */
const DEFAULT_UNITY = {
  world: "2022.3.22f1",
  avatar: "2022.3.22f1",
};

const UNITY_VERSION_RE = /^\d{4}\.\d+\.\d+[a-z]\d+$/;

class ScaffoldError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function describeContents(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) return "（空目录）";
    const shown = entries.slice(0, 8).join(", ");
    return entries.length > 8 ? `${shown} … 共 ${entries.length} 项` : shown;
  } catch {
    return "（无法读取）";
  }
}

/**
 * Plan what would be written, without touching the disk.
 * Every refusal happens here, so `apply` cannot fail on a condition `plan` passed.
 */
export function planProject(options = {}) {
  const { targetDir, type } = options;

  if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
    throw new ScaffoldError("bad-path", "必须给出要创建工程的目录");
  }
  if (!Object.hasOwn(VPM_SDK, type)) {
    throw new ScaffoldError(
      "bad-type",
      `type 只能是 ${Object.keys(VPM_SDK).join(" 或 ")}，收到 ${JSON.stringify(type)}`,
    );
  }

  const resolved = path.resolve(targetDir);
  const unityVersion = options.unityVersion ?? DEFAULT_UNITY[type];
  if (typeof unityVersion !== "string" || !UNITY_VERSION_RE.test(unityVersion)) {
    throw new ScaffoldError(
      "bad-unity-version",
      `Unity 版本格式不对：${JSON.stringify(unityVersion)}。应形如 2022.3.22f1`,
    );
  }

  // Existing target: refuse unless forced, and NAME what is there. Overwriting a
  // directory that already holds a Unity project would destroy real work, so the
  // message has to say enough that the caller can decide without re-running.
  const exists = fs.existsSync(resolved);
  let status = "absent";
  let contents = "";
  if (exists) {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new ScaffoldError("not-a-directory", `目标已存在且不是目录：${resolved}`);
    }
    const isProject = fs.existsSync(path.join(resolved, "ProjectSettings"));
    contents = describeContents(resolved);
    status = isProject ? "existing-project" : "existing-dir";
  } else {
    // Do not silently create a long chain of parents: a typo in the path would
    // then produce a whole tree in the wrong place.
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) {
      throw new ScaffoldError("parent-missing", `父目录不存在：${parent}`, {
        hint: "先确认路径拼写，或先创建上级目录。本工具不会替你建整条父链。",
      });
    }
  }

  if (exists && options.force !== true) {
    throw new ScaffoldError(
      status === "existing-project" ? "already-a-project" : "already-exists",
      status === "existing-project"
        ? `目标已是一个 Unity 工程：${resolved}`
        : `目标目录已存在：${resolved}`,
      {
        contents,
        hint: "如确认要覆盖，用 force: true —— 它会先备份到 <目录>.bak-<时间戳> 再建。",
      },
    );
  }

  const vpmManifest = {
    dependencies: { [VPM_SDK[type]]: { version: "3.x" } },
  };

  return {
    targetDir: resolved,
    type,
    unityVersion,
    status,
    contents,
    backupDir: exists ? `${resolved}.bak-${Date.now()}` : null,
    files: {
      "ProjectSettings/ProjectVersion.txt": `m_EditorVersion: ${unityVersion}\n`,
      "Packages/manifest.json": `${JSON.stringify({ dependencies: UNITY_DEPS }, null, 2)}\n`,
      "Packages/vpm-manifest.json": `${JSON.stringify(vpmManifest, null, 2)}\n`,
    },
    dirs: ["Assets", "ProjectSettings", "Packages"],
    resolvedSdk: VPM_SDK[type],
  };
}

/**
 * Carry out a plan. Writes into a sibling temp directory first and renames it into
 * place, so a partial write can never leave a half-built project at the target path.
 */
export function applyProject(plan) {
  const { targetDir, files, dirs, backupDir } = plan;

  let backup = null;
  if (backupDir !== null) {
    // Backup, never delete: if the caller was wrong, the original still exists.
    fs.renameSync(targetDir, backupDir);
    backup = backupDir;
  }

  const staging = `${targetDir}.tmp-${Date.now()}`;
  try {
    for (const dir of dirs) fs.mkdirSync(path.join(staging, dir), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(staging, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    fs.renameSync(staging, targetDir);
  } catch (error) {
    // Roll back: remove the half-built staging dir and put the backup back.
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* the staging dir is left behind; the error below still explains what failed */
    }
    if (backup !== null) {
      try {
        fs.renameSync(backup, targetDir);
        backup = null;
      } catch {
        /* fall through: report the backup path so nothing is lost silently */
      }
    }
    throw new ScaffoldError("write-failed", `写入失败：${error?.message ?? error}`, {
      targetDir,
      backupRestored: backup === null,
      backupPath: backup,
    });
  }

  return { targetDir, backup, files: Object.keys(files), dirs };
}

/** Human-facing summary. States what was NOT written, because that is the surprise. */
export function summarize(plan, result) {
  const lines = [
    `已创建 ${plan.type} 工程：${plan.targetDir}`,
    `  Unity     ${plan.unityVersion}`,
    `  SDK       ${plan.resolvedSdk} 3.x  （写在 Packages/vpm-manifest.json）`,
    "",
    "写入的文件：",
    ...result.files.map((f) => `  ${f}`),
    "",
    "未写入（由 Unity 首次打开时生成，本工具不伪造）：",
    "  ProjectSettings/ProjectSettings.asset",
    "  ProjectSettings/InputManager.asset",
    "  其余 ProjectSettings/*.asset",
  ];
  if (result.backup !== null) {
    lines.push("", `原内容已备份到：${result.backup}`);
  }
  lines.push(
    "",
    "下一步：SDK 还没装。让它就绪（需要本机有 vrc-get）：",
    `  vrc-get resolve -p "${plan.targetDir}"`,
    "然后打开工程：Unity 会补全其余设置。",
  );
  return lines.join("\n");
}

export { ScaffoldError, UNITY_DEPS, VPM_SDK, DEFAULT_UNITY };
