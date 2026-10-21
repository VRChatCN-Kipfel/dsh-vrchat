/**
 * Compile the upstream knowledge library into this bundle's `data/`.
 *
 * Inputs are two very different things on purpose:
 *   - `content-src/`     hand-curated, compressed blocks — the injected prompt text.
 *                        Editable line by line, reviewed by a human.
 *   - `../VRChat-Agent-Creator-Library/`  the upstream submodule — 414 pages, used
 *                        verbatim as the long-tail retrieval corpus.
 *
 * The build never re-derives the curated blocks from the corpus: that is what
 * makes the injected text reviewable and stable across upstream updates.
 *
 * Usage: node tools/build-knowledge.mjs
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, posix } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// The plugin body IS the repository root, so the upstream submodule sits beside
// it, not one level up.
const workspaceRoot = join(here, "..");
const contentSrc = join(workspaceRoot, "content-src");
const dataDir = join(workspaceRoot, "data");
const corpusRoot = join(
  workspaceRoot,
  "VRChat-Agent-Creator-Library",
  "memoryV5.0.0",
  "LLMWikiExample",
  "LLMWikiPage",
);

/**
 * Token estimate for mixed zh/en text.
 *
 * A flat `chars / N` formula is wrong here: Chinese runs near 1–1.6 chars per
 * token while ASCII runs near 3–4, and this corpus mixes both in every table.
 * Report a low/high band and treat the real number as coming from
 * `ctx.tokenMeter.measure()` on a live session.
 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
function estimateTokens(text) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else ascii++;
  }
  return {
    cjk,
    ascii,
    tokensLow: Math.round(cjk / 1.6 + ascii / 4.0),
    tokensHigh: Math.round(cjk / 1.0 + ascii / 3.0),
  };
}

async function readText(path) {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

/** Extract YAML frontmatter as flat scalars plus a list of list-valued keys. */
function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const block = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n+/, "");
  const meta = {};
  let currentList = null;
  for (const line of block.split("\n")) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentList !== null) {
      meta[currentList].push(listItem[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      currentList = key;
      meta[key] = [];
    } else {
      currentList = null;
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body };
}

async function walkMarkdown(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkMarkdown(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  let manifestKeywordRoutes = 0;

  // ── 1. Curated injected blocks ────────────────────────────────────────────
  const blocks = {
    "t0-core": join(contentSrc, "t0-core.md"),
    "t1-world": join(contentSrc, "t1-world.md"),
    "t1-avatar": join(contentSrc, "t1-avatar.md"),
    "t1-shader": join(contentSrc, "t1-shader.md"),
    "domain-map": join(contentSrc, "domain-map.md"),
  };

  const loaded = {};
  for (const [key, path] of Object.entries(blocks)) {
    loaded[key] = await readText(path);
  }

  for (const [key, text] of Object.entries(loaded)) {
    await writeFile(join(dataDir, `${key}.txt`), text, "utf8");
  }

  // Preset mode: coverage map + every domain block, in reading order.
  const alwaysLoad = [
    loaded["domain-map"],
    loaded["t1-world"],
    loaded["t1-avatar"],
    loaded["t1-shader"],
  ].join("\n\n---\n\n");
  await writeFile(join(dataDir, "always-load.txt"), alwaysLoad, "utf8");

  // ── 2. Retrieval corpus (upstream, verbatim) ──────────────────────────────
  const files = await walkMarkdown(corpusRoot);
  const index = [];
  const pages = {};

  for (const file of files) {
    const rel = posix.join(...relative(corpusRoot, file).split("\\"));
    const raw = await readText(file);
    const { meta, body } = parseFrontmatter(raw);
    index.push({
      path: rel,
      title: typeof meta.title === "string" ? meta.title : rel.replace(/\.md$/, ""),
      type: typeof meta.type === "string" ? meta.type : null,
      category: typeof meta.category === "string" ? meta.category : null,
      confidence: typeof meta.confidence === "string" ? meta.confidence.toLowerCase() : null,
      status: typeof meta.status === "string" ? meta.status : null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      size: raw.length,
    });
    pages[rel] = body;
  }

  index.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(dataDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
  await writeFile(join(dataDir, "pages.json"), JSON.stringify(pages), "utf8");

  // ── 2b. Concept → grep-pattern routes, taken from the upstream index.md table ──
  // These are the author's own hand-calibrated Chinese-concept-to-keyword table.
  // They become the TOOL's routing config, deliberately NOT injected prompt text:
  // the whole point is that the agent never has to know where anything lives.
  const keywordRoutes = await readText(join(corpusRoot, "index.md"))
    .then((raw) => {
      const start = raw.indexOf("## 搜索关键词");
      if (start === -1) return [];
      const end = raw.indexOf("\n---", start);
      const section = raw.slice(start, end === -1 ? undefined : end);
      const routes = [];
      for (const line of section.split("\n")) {
        if (!line.trim().startsWith("|")) continue;
        // Table cells contain escaped pipes (`a\|b`), so protect them first.
        const guarded = line.replace(/\\\|/g, "\u0001");
        const cells = guarded.split("|").map((cell) => cell.trim());
        if (cells.length < 4) continue;
        const concept = cells[1].replace(/\*\*/g, "").trim();
        const pattern = cells[2].replace(/\u0001/g, "|");
        const targetRaw = cells[3].replace(/\u0001/g, "|");
        if (concept === "" || concept === "领域" || /^[-:]+$/.test(concept)) continue;
        if (concept.startsWith("---")) continue;

        const keywords = pattern
          .replace(/`/g, "")
          .split("|")
          .map((token) => token.trim().replace(/\.\*/g, "").replace(/\\/g, ""))
          .filter((token) => token.length > 1 && !token.includes("源资料"));
        if (keywords.length === 0) continue;

        // Normalize the destination: wikilink → path, backticks → bare path.
        // Rows whose destination is prose ("源资料归档层…") carry no route.
        let target = targetRaw.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/`/g, "").trim();
        if (target.includes("不随发布包分发") || target.includes("源资料")) target = null;
        else if (target.startsWith("~") || target === "") target = null;
        else target = target.replace(/\s*§.*$/, "").replace(/^\.\//, "");
        if (target === null) continue;

        routes.push({ concept, keywords, target });
      }
      return routes;
    });
  await writeFile(join(dataDir, "keyword-routes.json"), JSON.stringify(keywordRoutes, null, 2), "utf8");
  manifestKeywordRoutes = keywordRoutes.length;

  // ── 2c. API availability table, parsed from the exposed-types page ───────
  // Parsed at BUILD time with the shipped, tested parser, so the plugin never
  // parses markdown at runtime and a parser bug surfaces here, not at boot.
  const { parseExposedTypes } = await import("../lib/api-table.js");
  const apiSource = await readText(join(corpusRoot, "entities", "api", "exposed-types.md"));
  const apiParsed = parseExposedTypes(apiSource);
  const apiTable = {
    source: "entities/api/exposed-types.md",
    note: "只收录已暴露成员；未暴露成员无导出数据，故「未收录」不等于不可用。",
    typeCount: apiParsed.types.length,
    memberCount: apiParsed.types.reduce((acc, type) => acc + type.members.length, 0),
    types: apiParsed.types.map((type) => ({
      type: type.type,
      fullName: type.fullName,
      exposureRate: type.exposureRate,
      memberCount: type.memberCount,
      members: type.members.map((member) => ({ raw: member.raw, name: member.name, kind: member.kind })),
    })),
  };
  await writeFile(join(dataDir, "api-table.json"), JSON.stringify(apiTable), "utf8");

  // ── 3. Manifest ───────────────────────────────────────────────────────────
  // Library version is read from the upstream README badge, not hardcoded.
  let libraryVersion = "unknown";
  try {
    const readme = await readText(join(workspaceRoot, "VRChat-Agent-Creator-Library", "README.md"));
    const badge = /Version:\s*(v[\d.]+)/i.exec(readme) ?? /\bv(\d+\.\d+\.\d+)\b/.exec(readme);
    if (badge !== null) libraryVersion = badge[1].replace(/^v/i, "");
  } catch {
    /* README absent in a partial checkout */
  }

  let upstreamHead = "unknown";
  try {
    upstreamHead = (await readText(join(workspaceRoot, "VRChat-Agent-Creator-Library", ".git")))
      .trim()
      .slice(0, 200);
  } catch {
    /* worktree gitdir file may be absent in a plain checkout */
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    libraryVersion: libraryVersion,
    corpusRoot: "VRChat-Agent-Creator-Library/memoryV5.0.0/LLMWikiExample/LLMWikiPage",
    upstreamGitPointer: upstreamHead,
    pageCount: index.length,
    keywordRoutes: manifestKeywordRoutes,
    apiTableTypes: apiTable.typeCount,
    apiTableMembers: apiTable.memberCount,
    confidenceDistribution: index.reduce((acc, page) => {
      const key = page.confidence ?? "unset";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    blocks: Object.fromEntries(
      Object.entries({ ...loaded, "always-load": alwaysLoad }).map(([key, text]) => [
        key,
        { chars: text.length, ...estimateTokens(text) },
      ]),
    ),
    presetPayload: {
      // Preset mode registers the SAME section name as the global row, so it
      // shadows it completely and must therefore carry T0 itself.
      includes: ["t0-core", "domain-map", "t1-world", "t1-avatar", "t1-shader"],
      estimatedTokensLow: ["t0-core", "domain-map", "t1-world", "t1-avatar", "t1-shader"]
        .map((key) => estimateTokens(loaded[key]).tokensLow)
        .reduce((a, b) => a + b, 0),
      estimatedTokensHigh: ["t0-core", "domain-map", "t1-world", "t1-avatar", "t1-shader"]
        .map((key) => estimateTokens(loaded[key]).tokensHigh)
        .reduce((a, b) => a + b, 0),
    },
  };
  await writeFile(join(dataDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // ── 4. Report ─────────────────────────────────────────────────────────────
  console.log(`corpus pages: ${index.length}`);
  console.log(`data/: ${dataDir}`);
  for (const [key, info] of Object.entries(manifest.blocks)) {
    console.log(
      `  ${key.padEnd(12)} ${String(info.chars).padStart(6)} chars  ~${info.tokensLow}–${info.tokensHigh} tok`,
    );
  }
  const preset = manifest.presetPayload;
  console.log(
    `  node default T0 only        ~${manifest.blocks["t0-core"].tokensLow}–${manifest.blocks["t0-core"].tokensHigh} tok`,
  );
  console.log(`  preset mode payload         ~${preset.estimatedTokensLow}–${preset.estimatedTokensHigh} tok`);
}

await main();
