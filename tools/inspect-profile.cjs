/** Inspect the profile's bundle state and patch integrity. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");

const profileDir = process.env.DSH_PROFILE_DIR ?? "";
console.log(`profile: ${profileDir}`);

// ── 1. the patch must parse, and must not mention the plugin as disabled ──
const patchPath = path.join(profileDir, "cordis.patch.yml");
const patchText = fs.readFileSync(patchPath, "utf8");
console.log(`\n[cordis.patch.yml] ${patchText.split("\n").length} 行, ${patchText.length} 字符`);

let parsed = null;
try {
  parsed = YAML.parse(patchText);
  console.log(`  解析: OK, 顶层条目 ${parsed.length}`);
} catch (error) {
  console.log(`  解析: FAIL — ${error.message}`);
}

const mentions = patchText.split("\n").filter((line) => /vrchat/i.test(line));
console.log(`  含 "vrchat" 的行: ${mentions.length}`);
for (const line of mentions) console.log(`    ${line}`);

// ── 2. every disabled row in the patch ────────────────────────────────────
if (Array.isArray(parsed)) {
  const disabled = parsed.filter((entry) => entry && typeof entry === "object" && entry.disabled === true);
  console.log(`\n[disabled 条目] ${disabled.length}`);
  for (const entry of disabled) console.log(`  ${JSON.stringify(entry).slice(0, 160)}`);

  const inserts = parsed.filter((entry) => Array.isArray(entry?.insert));
  console.log(`\n[insert 块] ${inserts.length}`);
  let rowCount = 0;
  for (const block of inserts) rowCount += block.insert.length;
  console.log(`  合计插入行: ${rowCount}`);
}

// ── 3. the bundle must be selected ────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
console.log(`\n[profile/package.json]`);
console.log(`  bundles: ${JSON.stringify(pkg.dsh?.profile?.bundles ?? null)}`);
console.log(`  dependencies 含 dsh-vrchat-kb: ${Object.hasOwn(pkg.dependencies ?? {}, "dsh-vrchat-kb")}`);
console.log(`  devDependencies 含: ${Object.hasOwn(pkg.devDependencies ?? {}, "dsh-vrchat-kb")}`);
