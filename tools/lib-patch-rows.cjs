/**
 * Shared helpers for verifying an INSTALLED generation's patch.
 *
 * The patch now has TWO rows with different jobs (always-on tools + the preset
 * that injects), so anything that assumed `insert[0]` is the preset breaks. These
 * helpers locate rows by what they ARE, not by where they happen to sit.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromProfile = createRequire(path.join(process.env.DSH_PROFILE_DIR ?? ".", "noop.js"));
const YAML = requireFromProfile("yaml");
const generations = require("./lib-generation.cjs");

/** Absolute path of the newest installed package directory. */
function installedPackageDir() {
  const target = generations.newestGeneration("dsh-vrchat-kb+");
  if (target === null) return null;
  return {
    generation: target,
    dir: path.join(generations.liveRoot(), target, "node_modules", "dsh-vrchat-kb"),
  };
}

/** Parse the installed patch, or throw with a usable message. */
function installedPatch(pkgDir) {
  const file = path.join(pkgDir, "cordis.patch.yml");
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Locate the two rows by identity.
 * @param patch - parsed patch document.
 * @returns `{ preset, alwaysOn, persona, presetKb, rows }`.
 */
function locateRows(patch) {
  const rows = patch?.[0]?.insert ?? [];
  const preset = rows.find((row) => row.id === "preset-vrchat");
  const alwaysOn = rows.find((row) => row.name === "dsh-vrchat-kb" && row.id !== "preset-vrchat");
  const plugins = preset?.config?.plugins ?? [];
  return {
    rows,
    preset,
    alwaysOn,
    persona: plugins.find((plugin) => plugin.id === "persona"),
    presetKb: plugins.find((plugin) => plugin.name === "dsh-vrchat-kb"),
  };
}

module.exports = { installedPackageDir, installedPatch, locateRows };
