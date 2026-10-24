/**
 * Drive the REAL `vrchat_kb_project_new` handler and assert on the filesystem.
 *
 * The lib self-test calls `planProject`/`applyProject` directly, which proves the
 * logic but not the wiring: a tool can register fine and still return the wrong
 * shape, swallow an error, or lose the `force` flag between args and the lib. This
 * runs the registered tool exactly as a session would.
 *
 * Usage: node tools/probe-project-new.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

function makeContext() {
  const tools = [];
  return {
    tools,
    ctx: {
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      systemPrompt: { section: () => () => {} },
      tools: { register: (def) => (tools.push(def), () => {}) },
      effect: (fn) => {
        fn();
        return () => {};
      },
      get: () => undefined,
    },
  };
}

async function loadStubbed() {
  const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const noop = new Proxy({}, { get: (_t, key) => (key === "default" ? () => noop : () => noop) });
  const patched = source
    .replace(/import z from "@deepseek-ai\/schemastery";/, "const z = globalThis.__z;")
    .replace(/import \{ z as zod \} from "zod";/, "const zod = globalThis.__z;")
    .replace(/import \{ defineTool \} from "@deepseek-ai\/dsh-tools";/, "const defineTool = (d) => d;");
  globalThis.__z = noop;
  const tmp = path.join(ROOT, ".probe-project-new.mjs");
  fs.writeFileSync(tmp, patched, "utf8");
  return await import(`${pathToFileURL(tmp).href}?v=${Date.now()}`);
}

async function main() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const mod = await loadStubbed();
  const harness = makeContext();
  mod.apply(harness.ctx, { tier: "preset" });

  const tool = harness.tools.find((t) => t.name === "vrchat_kb_project_new");
  check("工具已注册", tool !== undefined);
  if (tool === undefined) return report();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vrchat-probe-"));
  try {
    // ── clean create through the handler ────────────────────────────────
    const target = path.join(base, "ProbeWorld");
    const ok = await tool.execute({ targetDir: target, type: "world" });
    check("返回 ok", ok.ok === true, JSON.stringify(ok.code));
    check("返回 targetDir", ok.targetDir === target, ok.targetDir);
    check("返回 nextCommand 指向 resolve", String(ok.nextCommand).includes("vrc-get resolve"), ok.nextCommand);
    check("文件真的落盘", fs.existsSync(path.join(target, "Packages", "vpm-manifest.json")));
    check("文本里声明 SDK 未装", String(ok.text).includes("SDK 还没装"));

    // ── existing project is refused through the handler ─────────────────
    const refused = await tool.execute({ targetDir: target, type: "world" });
    check("重复创建被拒绝", refused.ok === false, String(refused.ok));
    check("拒绝码为 already-a-project", refused.code === "already-a-project", refused.code);
    check("拒绝文本列出内容", String(refused.text).includes("目标现有内容"));
    check("原工程仍在", fs.existsSync(path.join(target, "ProjectSettings", "ProjectVersion.txt")));

    // ── dryRun does not touch the disk ──────────────────────────────────
    const fresh = path.join(base, "DryWorld");
    const dry = await tool.execute({ targetDir: fresh, type: "avatar", dryRun: true });
    check("dry-run 返回 ok", dry.ok === true, String(dry.code));
    check("dry-run 文本标记 [dry-run]", String(dry.text).startsWith("[dry-run]"));
    check("dry-run 没创建目录", !fs.existsSync(fresh));

    // ── bad type through the handler ─────────────────────────────────────
    const bad = await tool.execute({ targetDir: path.join(base, "Bad"), type: "scene" });
    check("非法 type 被拒绝", bad.ok === false && bad.code === "bad-type", bad.code);
    check("非法 type 文本给出合法值", String(bad.text).includes("world") && String(bad.text).includes("avatar"));

    // ── force through the handler ────────────────────────────────────────
    const dir = path.join(base, "Forced");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep me");
    const forced = await tool.execute({ targetDir: dir, type: "avatar", force: true });
    check("force 成功", forced.ok === true, String(forced.code));
    check("force 返回备份路径", typeof forced.backup === "string" && forced.backup.length > 0, forced.backup);
    check("备份里有原文件", fs.existsSync(path.join(String(forced.backup), "keep.txt")));
    check("目标现在是工程", fs.existsSync(path.join(dir, "Packages", "vpm-manifest.json")));

    // ── missing parent through the handler ──────────────────────────────
    const deep = path.join(base, "no", "such", "dir");
    const parentErr = await tool.execute({ targetDir: deep, type: "world" });
    check("父目录缺失被拒绝", parentErr.ok === false && parentErr.code === "parent-missing", parentErr.code);
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* temp dir is disposable */
    }
    // Same reason as probe-command.cjs: fs.rmSync on the stub crashes Node 24.9 on
    // Windows with 0xC0000409. The file is gitignored and rewritten each run.
  }

  return report();

  function report() {
    let failed = 0;
    for (const item of checks) {
      if (!item.ok) failed++;
      console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
    }
    console.log("");
    console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("PROBE FAILED:", error?.stack ?? error);
  process.exit(1);
});
