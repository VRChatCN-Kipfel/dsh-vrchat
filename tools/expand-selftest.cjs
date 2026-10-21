/**
 * Offline self-test for the `vrchat_kb_scan` directory expansion.
 *
 * Exercises the walk against a real temp tree with a fake `fs` service that
 * implements the exact methods the tool uses (resolve / stat / listDir /
 * readText), so the expansion rules are tested without the Harness.
 *
 * Usage: node tools/expand-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Methods the scan tool may call on `ctx.fs`. */
function makeFakeFs() {
  const target = (abs) => ({ targetKey: abs, displayPath: abs });
  return {
    async resolve(p, { cwd } = {}) {
      return target(path.resolve(cwd ?? process.cwd(), p));
    },
    async stat(t) {
      let info;
      try {
        info = fs.statSync(t.targetKey);
      } catch {
        return undefined;
      }
      return {
        version: "v",
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size,
      };
    },
    async listDir(t) {
      return fs
        .readdirSync(t.targetKey, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          target: target(path.join(t.targetKey, entry.name)),
        }));
    },
    async readText(t) {
      return fs.readFileSync(t.targetKey, "utf8");
    },
  };
}

/**
 * Verbatim copy of the plugin's expansion contract, kept here so the rules can
 * be tested without loading index.js (which imports Harness packages).
 */
const SCANNABLE = new Set([".cs", ".shader"]);
const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 6;
const PRUNE = new Set(["node_modules", ".git", "library", "temp", "obj", "logs", "build", "packages"]);

async function expandTargets(fsService, entries, cwd, signal) {
  const files = [];
  const skipped = [];
  const seen = new Set();

  const accept = (p, size) => {
    const extension = `.${p.split(".").pop().toLowerCase()}`;
    if (!SCANNABLE.has(extension)) {
      skipped.push(`${p}（不是可扫描类型，仅 .cs / .shader）`);
      return false;
    }
    if (seen.has(p)) return false;
    if (size !== undefined && size > MAX_BYTES) {
      skipped.push(`${p}（超过 ${MAX_BYTES / 1024} KB）`);
      return false;
    }
    seen.add(p);
    return true;
  };

  const walk = async (displayPath, depth, knownTarget) => {
    if (files.length >= MAX_FILES) return;
    if (depth > MAX_DEPTH) {
      skipped.push(`${displayPath}（目录层级超过 ${MAX_DEPTH}）`);
      return;
    }
    let target = knownTarget;
    let info;
    try {
      if (target === undefined) target = await fsService.resolve(displayPath, { cwd, signal });
      info = await fsService.stat(target, signal);
    } catch (error) {
      skipped.push(`${displayPath}（无法访问：${String(error?.message ?? error)}）`);
      return;
    }
    if (info === undefined) {
      skipped.push(`${displayPath}（不存在）`);
      return;
    }
    if (info.type === "file") {
      if (accept(displayPath, info.size)) files.push({ path: displayPath, target });
      return;
    }
    if (info.type !== "directory") {
      skipped.push(`${displayPath}（不是常规文件或目录）`);
      return;
    }
    let children;
    try {
      children = await fsService.listDir(target, signal);
    } catch (error) {
      skipped.push(`${displayPath}（无法列出：${String(error?.message ?? error)}）`);
      return;
    }
    const base = displayPath.replace(/\/+$/, "");
    for (const child of children) {
      const name = typeof child?.name === "string" ? child.name : "";
      if (name.length === 0) continue;
      if (PRUNE.has(name.toLowerCase())) continue;
      const childPath = `${base}/${name}`;
      if (child.type === "directory") await walk(childPath, depth + 1, child.target);
      else if (child.type === "file" && accept(childPath, child.size)) {
        if (files.length < MAX_FILES) files.push({ path: childPath, target: child.target });
      }
    }
  };

  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      skipped.push(`已达 ${MAX_FILES} 个文件上限，其余未展开`);
      break;
    }
    await walk(entry, 0, undefined);
  }
  return { files, skipped };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrchat-scan-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };

  write("Assets/Scripts/Bad.cs", "class B { void U() { var l = new List<int>(); } }");
  write("Assets/Scripts/Good.cs", "class G { void S() { var a = new GameObject[4]; } }");
  write("Assets/Scripts/Editor/Inspector.cs", "using UnityEditor;\nclass I { }");
  write("Assets/Shaders/Toon.shader", "Shader \"X\" { }\nfloat4 _VRChatVar;");
  write("Library/junk.cs", "async void X() { await Y(); }");
  write("node_modules/dep.cs", "try { } catch { }");

  // Plant one UnityEditor reference OUTSIDE an Editor folder: that one must fire,
  // while the copy inside `Editor/` must stay silent (both are asserted below).
  write("Assets/Scripts/PlainInspector.cs", "using UnityEditor;\nclass P { }");
  write("Assets/Scripts/notes.txt", "ignore me");

  const fake = makeFakeFs();

  const checks = [];
  const check = (name, condition, detail) => checks.push({ name, ok: Boolean(condition), detail });

  // A directory entry expands to its scannable files, recursively.
  const dir = await expandTargets(fake, ["Assets"], root, undefined);
  const paths = dir.files.map((f) => f.path).sort();
  check("目录递归展开", paths.length === 5, paths.join(", "));
  check("只收 .cs / .shader", !paths.some((p) => p.endsWith(".txt")), paths.join(", "));
  check("Editor 子目录也被包含", paths.includes("Assets/Scripts/Editor/Inspector.cs"));
  check("跳过了 Library/", !paths.some((p) => p.includes("Library")));
  check("跳过了 node_modules/", !paths.some((p) => p.includes("node_modules")));
  check("对非扫描类型记录跳过原因", dir.skipped.some((s) => s.includes("notes.txt")), dir.skipped.join(" | "));

  // Mixed file + directory entries, and de-duplication.
  const mixed = await expandTargets(fake, ["Assets/Scripts/Bad.cs", "Assets"], root, undefined);
  check("文件+目录混合且不重复", mixed.files.filter((f) => f.path === "Assets/Scripts/Bad.cs").length === 1);

  // A missing path is reported, not thrown.
  const missing = await expandTargets(fake, ["Assets/Nope"], root, undefined);
  check("不存在的路径被报告", missing.files.length === 0 && missing.skipped.some((s) => s.includes("不存在")), missing.skipped.join(" | "));

  // A plain file entry still works.
  const single = await expandTargets(fake, ["Assets/Shaders/Toon.shader"], root, undefined);
  check("单文件直接接受", single.files.length === 1 && single.files[0].path === "Assets/Shaders/Toon.shader");

  // The resolved target travels with each file (no second resolve on read).
  check("每条结果自带 target", single.files[0].target !== undefined && typeof single.files[0].target.targetKey === "string");

  // Plant one UnityEditor reference OUTSIDE an Editor folder: that one must fire,
  // while the copy inside `Editor/` must stay silent (both are asserted below).
  write("Assets/Scripts/PlainInspector.cs", "using UnityEditor;\nclass P { }");

  // And the scan itself finds the planted violations through those targets.
  const lint = await import(new URL("../lib/lint.js", `file:///${__dirname.replace(/\\/g, "/")}/`).href);
  const findings = [];
  for (const file of dir.files) findings.push(...lint.lintSource(file.path, await fake.readText(file.target)));
  const rules = [...new Set(findings.map((f) => f.rule))].sort();
  check("命中泛型集合", rules.includes("udon-banned-collection"), rules.join(", "));
  check("命中 Editor 目录外的 UnityEditor", rules.includes("unityeditor-outside-editor"));
  check("命中 _VRChat 前缀", rules.includes("vrc-protected-shader-namespace"));
  check("Good.cs 未误报", !findings.some((f) => f.file === "Assets/Scripts/Good.cs"));
  check(
    "Editor/ 内的 UnityEditor 未误报",
    !findings.some(
      (f) => f.file === "Assets/Scripts/Editor/Inspector.cs" && f.rule === "unityeditor-outside-editor",
    ),
  );

  fs.rmSync(root, { recursive: true, force: true });

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
