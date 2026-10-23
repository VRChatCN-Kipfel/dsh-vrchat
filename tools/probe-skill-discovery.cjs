/**
 * Ask the REAL provider whether it finds the vendored skills.
 *
 * Every other skill check reads files and re-implements the discovery rules. That
 * proves the files are shaped right; it does not prove the provider agrees, and the
 * two have diverged before — the root-level `*.md` → whole-directory-resourceBase
 * branch is easy to miss when reading by hand.
 *
 * This instantiates dsh-skill-filesystem's own provider against the two vendored
 * roots and reports what it returns.
 *
 * Usage: node tools/probe-skill-discovery.cjs
 */
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const { findHostModules } = require("./lib-host-modules.cjs");
const requireHost = createRequire(path.join(findHostModules(), "noop.js"));

async function main() {
  const roots = [
    path.join(ROOT, "vendor", "vrchat-world-codex-skills"),
    path.join(ROOT, "vendor", "vrchat-editor-skill"),
  ];

  const entry = requireHost.resolve("@deepseek-ai/dsh-skill-filesystem");
  const mod = await import(pathToFileURL(entry).href);

  const logs = [];
  const ctx = {
    logger: { warn: (m) => logs.push(`warn: ${m}`), info: () => {}, debug: () => {} },
    // `optionalFileSystem` probes for an injected `fs` service; returning undefined
    // makes the provider fall back to plain Node reads, which is what we want here.
    get: () => undefined,
  };

  const provider = new mod.FileSystemSkillProvider(
    ctx,
    { invalidate: () => {}, signal: new AbortController().signal },
    { providerName: "vrchat-skills", includeDefaultRoots: false, customSkillDirs: roots, watch: false },
  );

  const candidateList = await provider.list({ cwd: ROOT });
  const list = Array.isArray(candidateList) ? candidateList : (candidateList?.candidates ?? []);

  console.log(`provider.list 返回 ${list.length} 个技能（complete=${Array.isArray(candidateList)}）：\n`);
  for (const skill of list) {
    const desc = String(skill.description ?? "").replaceAll(/\s+/g, " ").trim();
    console.log(`  ${String(skill.name).padEnd(34)} ${String(desc.length).padStart(4)} 字符  rank=${skill.rank} source=${skill.source}`);
    if (skill.resourceBase !== undefined) {
      console.log(`      资源根: ${skill.resourceBase.kind} ${skill.resourceBase.path}`);
    }
  }

  // `get()` is what the model actually receives — prove the body is reachable too.
  if (list.length > 0) {
    const first = await provider.get(list[0], { signal: new AbortController().signal });
    console.log(`\nget("${first?.name}"): ${String(first?.content ?? "").length} 字符正文`);
  }

  console.log(`\n日志 ${logs.length} 条`);
  for (const line of logs.slice(0, 10)) console.log(`  ${line}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
