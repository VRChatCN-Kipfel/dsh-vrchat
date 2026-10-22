/** Prove the installed patch parses to the values we intended. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR, "noop.js"));
const YAML = requireFromProfile("yaml");
const { installedPackageDir, installedPatch, locateRows } = require("./lib-patch-rows.cjs");

const found = installedPackageDir();
console.log(`代: ${found.generation}`);
const patch = installedPatch(found.dir);
const rows = locateRows(patch);
const reader = rows.preset.config.plugins.find((plugin) => plugin.id === "tool-skill");
const provider = rows.preset.config.plugins.find((plugin) => plugin.id === "vrchat-skills");

console.log(`preset 插件行数: ${rows.preset.config.plugins.length}`);
console.log(`tool-skill.catalogDescriptionMaxLength: ${reader.config.catalogDescriptionMaxLength}`);
console.log(`customSkillDirs (${provider.config.customSkillDirs.length}):`);
for (const entry of provider.config.customSkillDirs) console.log(`  - ${entry}`);
