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
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const { findHostModules } = require("./lib-host-modules.cjs");
const requireHost = createRequire(path.join(findHostModules(), "noop.js"));

async function main() {
  // Must mirror `customSkillDirs` in the shipped row. If this list drifts from the
  // build script the probe keeps passing while the real preset serves a different
  // set — the failure mode this whole file exists to prevent.
  const roots = [
    path.join(ROOT, "vendor", "vrchat-world-codex-skills"),
    path.join(ROOT, "vendor", "vrchat-editor-skill"),
    path.join(ROOT, "vendor", "vrc-get-cli"),
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

  // Config matches the shipped row: `includeDefaultRoots` is deliberately ABSENT so
  // the provider uses its documented default (`true`). Pinning it here would make
  // this probe agree with a config that no longer exists.
  const provider = new mod.FileSystemSkillProvider(
    ctx,
    { invalidate: () => {}, signal: new AbortController().signal },
    { providerName: "vrchat-skills", customSkillDirs: roots, watch: false },
  );

  const candidateList = await provider.list({ cwd: ROOT });
  const list = Array.isArray(candidateList) ? candidateList : (candidateList?.candidates ?? []);

  // Two roots are ours; anything else came from a default root. Report the split so
  // a lost `!!js` root (empty vendored half) cannot hide behind a healthy total.
  const vendored = new Set(roots.map((root) => path.resolve(root)));
  const isVendored = (skill) => {
    const base = skill.resourceBase?.path;
    if (typeof base !== "string") return false;
    const resolved = path.resolve(base);
    for (const root of vendored) {
      if (resolved === root || resolved.startsWith(root + path.sep)) return true;
    }
    return false;
  };

  console.log(`provider.list 返回 ${list.length} 个技能（complete=${Array.isArray(candidateList)}）：\n`);
  for (const skill of list) {
    const desc = String(skill.description ?? "").replaceAll(/\s+/g, " ").trim();
    const origin = isVendored(skill) ? "随包" : "默认根";
    console.log(`  [${origin}] ${String(skill.name).padEnd(30)} ${String(desc.length).padStart(4)} 字符  rank=${skill.rank} source=${skill.source}`);
    if (skill.resourceBase !== undefined) {
      console.log(`      资源根: ${skill.resourceBase.kind} ${skill.resourceBase.path}`);
    }
  }

  const vendoredCount = list.filter(isVendored).length;
  console.log(`\n随包技能 ${vendoredCount} 个 / 默认根技能 ${list.length - vendoredCount} 个`);
  // Count the skills under OUR roots by discovery, not by a literal: a hardcoded
  // floor silently rots the moment a root is added, and the point of this check is
  // to catch a LOST root, not to police how many we ship.
  //
  // The shape rule mirrors the provider's, including the part that is easy to miss:
  //   · a root-level `*.md` counts ONLY when it opens with YAML frontmatter carrying
  //     name + description. `README.md` sits beside `SKILL.md` in BOTH vendored roots
  //     and the provider ignores it with a warning — counting it inflates the
  //     expectation by two and makes this check report a permanent false "lost root";
  //   · a DIRECTORY counts only when it holds a `SKILL.md`;
  //   · everything else (references/, assets/, docs/) is a resource directory.
  const isSkillFile = (file) => {
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (!text.startsWith("---\n")) return false;
    const end = text.indexOf("\n---", 3);
    if (end === -1) return false;
    const front = text.slice(4, end);
    return /^name:\s*\S/m.test(front) && /^description:/m.test(front);
  };
  const expected = roots.reduce((n, root) => {
    if (!fs.existsSync(root)) return n;
    return (
      n +
      fs.readdirSync(root).filter((name) => {
        const full = path.join(root, name);
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        if (stat === undefined) return false;
        return stat.isFile() ? name.endsWith(".md") && isSkillFile(full) : isSkillFile(path.join(full, "SKILL.md"));
      }).length
    );
  }, 0);
  if (vendoredCount !== expected) {
    console.log(`✗ 随包技能 ${vendoredCount} 个，但 ${roots.length} 个根里应有 ${expected} 个 —— customSkillDirs 可能丢了一整个根`);
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
