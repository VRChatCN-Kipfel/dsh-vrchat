/**
 * Verify that SDK identifiers cited in the persona exist in the corpus.
 *
 * The persona names concrete prefabs (`VRCWorld`, `VRCChair`, ...) that an agent
 * will then look for. A name that does not exist sends it hunting for something
 * imaginary, which is worse than naming nothing.
 *
 * Usage: node tools/cited-identifiers.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");

const root = path.join(__dirname, "..");
const patch = YAML.parse(fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8"));
const persona = patch[0].insert[0].config.plugins.find((plugin) => plugin.id === "persona");
const personaText = `${persona?.config?.prefix ?? ""}\n${persona?.config?.suffix ?? ""}`;

// The corpus now lives in the workspace checkout, so read it there rather than
// from a bundled body map.
const corpusRoot = (() => {
  const relative = ["VRChat-Agent-Creator-Library", "memoryV5.0.0", "LLMWikiExample", "LLMWikiPage"];
  return path.join(root, ...relative);
})();
const { execSync } = require("node:child_process");
const corpus = (() => {
  try {
    // `findstr`-free: let Node read the tree once. 414 small files is fine for a
    // build-time guard.
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".md") ? [fs.readFileSync(full, "utf8")] : [];
      });
    return walk(corpusRoot).join("\n");
  } catch {
    return "";
  }
})();

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// Concrete VRC SDK identifiers the persona promises exist.
const IDENTIFIERS = [
  "VRCWorld",
  "VRCChair",
  "VRCMirror",
  "VRCPlayerApi",
  "VRCShader",
  "VRCGraphics",
  "VRCContactReceiver",
  "UdonSharpBehaviour",
  "DataList",
  "DataDictionary",
  "VRCObjectPool",
  "VRCObjectSync",
  "RecursiveMethod",
  "PlayerData",
  "PlayerObject",
];

const cited = IDENTIFIERS.filter((identifier) => personaText.includes(identifier));
for (const identifier of cited) {
  check(`引用的 ${identifier} 在语料中存在`, corpus.includes(identifier));
}

check("至少引用了一个 SDK 标识符", cited.length > 0, `${cited.length} 个`);

// Vague-request handling must exist: the whole point is not to stall the user.
check("含模糊需求分支", /一句话或情绪/.test(personaText));
check("禁止拿技术问题问小白", /不要问"你要 PC 还是 Quest|不要拿技术问题问他/.test(personaText));
check("给出默认值表", /平台\s+PC/.test(personaText) && /性能档\s+Medium/.test(personaText));
check("要求先给能跑的版本", /能上传、能进去、不会报错/.test(personaText));
check("禁止用追问结束对话", /不要用"请提供更多信息"结束/.test(personaText));

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
