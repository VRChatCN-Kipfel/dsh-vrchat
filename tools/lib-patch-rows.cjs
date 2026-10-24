/**
 * Shared helpers for verifying an INSTALLED generation's patch.
 *
 * The patch now has TWO rows with different jobs (always-on tools + the preset
 * that injects), so anything that assumed `insert[0]` is the preset breaks. These
 * helpers locate rows by what they ARE, not by where they happen to sit.
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadFromHost } = require("./lib-host-require.cjs");
const requireFromProfile = loadFromHost;
const YAML = requireFromProfile("yaml");
const generations = require("./lib-generation.cjs");

/** Absolute path of the newest installed package directory. */
function installedPackageDir() {
  const target = generations.newestGeneration("dsh-vrchat+");
  if (target === null) return null;
  return {
    generation: target,
    dir: path.join(generations.liveRoot(), target, "node_modules", "dsh-vrchat"),
  };
}

/** Parse YAML with the application tag the patch actually uses. */
function parsePatchText(text) {
  // `!!js` is a Loader tag, not a standard one. Parsing without it still yields the
  // expression as a plain string — which is what every caller here wants — but yaml
  // emits an "Unresolved tag" warning per occurrence. Four warnings above a PASS
  // list teach the reader to skim the output, and skimming is how the fifth, real
  // warning gets missed.
  const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value) => value, identify: () => false };
  return YAML.parse(text, { customTags: [jsTag] });
}

/** Parse the installed patch, or throw with a usable message. */
function installedPatch(pkgDir) {
  const file = path.join(pkgDir, "cordis.patch.yml");
  return parsePatchText(fs.readFileSync(file, "utf8"));
}

/**
 * Locate the two rows by identity.
 * @param patch - parsed patch document.
 * @returns `{ preset, alwaysOn, persona, presetKb, rows }`.
 */
function locateRows(patch) {
  const rows = patch?.[0]?.insert ?? [];
  const preset = rows.find((row) => row.id === "preset-vrchat");
  const alwaysOn = rows.find((row) => row.name === "dsh-vrchat" && row.id !== "preset-vrchat");
  const plugins = preset?.config?.plugins ?? [];
  return {
    rows,
    preset,
    alwaysOn,
    persona: plugins.find((plugin) => plugin.id === "persona"),
    presetKb: plugins.find((plugin) => plugin.name === "dsh-vrchat"),
  };
}

/** Parse the working tree's own patch, with the same tag handling. */
function workingPatch() {
  return parsePatchText(fs.readFileSync(path.join(__dirname, "..", "cordis.patch.yml"), "utf8"));
}

module.exports = { installedPackageDir, installedPatch, workingPatch, locateRows };
