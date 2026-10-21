/** Render the exact text this plugin injects, with cost. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const t0 = readFileSync(join(root, "data/t0-core.txt"), "utf8");
const alwaysLoad = readFileSync(join(root, "data/always-load.txt"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "data/manifest.json"), "utf8"));

const blockOf = (key) => manifest.blocks[key];
const provenance = (key) =>
  [
    `库 v${manifest.libraryVersion ?? "?"} / 上游 ${manifest.pageCount ?? "?"} 页 / 构建 ${String(manifest.builtAt ?? "").slice(0, 10)}`,
    blockOf(key) === undefined ? "" : `本块 ${blockOf(key).tokensLow}–${blockOf(key).tokensHigh} tok`,
  ]
    .filter((line) => line.length > 0)
    .join(" · ");

const lite = `${t0}\n\n> ${provenance("t0-core")}`;
const full = `${t0}\n\n---\n\n${alwaysLoad}\n\n> ${provenance("always-load")}`;

const show = (label, text) => {
  console.log(`===== ${label} =====`);
  console.log(text);
  console.log("");
  console.log(`字符 ${text.length} / 行 ${text.split("\n").length}`);
  console.log("");
};

// The two tiers differ in WHETHER they inject, not in how much:
//   lite / tools-only  → nothing is injected (this script prints only what a
//                        preset instance WOULD inject, for size awareness)
//   preset / full      → one section at order 640
show("常驻行 tier=lite 不注入；以上是预设行 tier=preset 会注入的红线块", lite);
show("preset 完整档（与 tier=preset 相同，full 仅为兼容别名）", full);
