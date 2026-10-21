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
import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, posix } from "node:path";
const require = createRequire(import.meta.url);
// The deployment ships `yaml` (it is a Host dependency), and the patch is
// serialized with it rather than hand-templated — a single misplaced block
// scalar breaks activation of the whole preset. It is deliberately NOT a
// dependency of this package: only this build tool needs it, and the shipped
// plugin reads no YAML at runtime.
let YAML;
try {
  YAML = require(join(process.env.DSH_PROFILE_DIR ?? "", "node_modules", "yaml"));
} catch {
  console.error(
    "缺少 yaml 解析器：本脚本从 DSH 安装目录读取它。\n" +
      "请在装有 DSH 的环境运行，或设置 DSH_PROFILE_DIR 指向一个含 node_modules/yaml 的 profile。",
  );
  process.exit(2);
}

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

/**
 * Indent a block scalar so it nests correctly under `prefix: |-`.
 *
 * YAML block scalars require EVERY non-empty line to share one indentation;
 * a single over-indented continuation line (a markdown list wrap, for example)
 * would either be parsed as deeper structure or break the scalar. So the input
 * is first de-indented to its own common minimum, then re-indented uniformly.
 */
function blockScalar(text, indent) {
  const lines = text.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => /^\s*/.exec(line)[0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  const pad = " ".repeat(indent);
  return lines
    .map((line) => {
      if (line.trim().length === 0) return "";
      return `${pad}${line.slice(common)}`;
    })
    .join("\n");
}

/**
 * Render the bundle patch.
 *
 * Generated rather than hand-maintained: the persona text is the single source
 * of truth (content-src/persona-prefix.md plus the curated blocks), and a patch
 * embedding a copy would drift the moment someone edited only one side.
 *
 * TWO rows, with different jobs:
 *
 *   vrchat-kb (tier: lite)   always mounted. Registers the six tools and the
 *                           `/vrchat` command, and injects NO prompt text. A
 *                           session that never selects the preset therefore pays
 *                           only the tool definitions — the agent can still ask
 *                           the library a question.
 *
 *   preset-vrchat            the preset. Mounts a second instance at
 *                           `tier: preset`, which is what injects the persona,
 *                           in two halves:
 *                             prefix (order 0)      identity and domain facts
 *                             suffix (order 10200)  red lines and the full digest
 *
 * Injection stays preset-gated on purpose: the knowledge only becomes the
 * agent's identity when the user asked for it. Note that `tier: lite` still
 * injects the short red-line block by contract — see the tier branches in
 * index.js — so the "zero injection" claim is scoped to the preset text.
 */
function renderPatch(personaPrefix, personaSuffix) {
  const header = `# dsh-vrchat-kb — VRChat 创作知识库  【本文件由 tools/build-knowledge.mjs 生成，不要手改】
#
# 两行，职责不同：
#
#   vrchat-kb (tier: lite)    常驻挂载。只注册工具与 /vrchat 命令，不注入预设人格。
#                             不选预设的会话仍可向知识库提问。
#   preset-vrchat             预设。以 tier: preset 再挂一份，注入人设：
#       prefix (order 0)      专家身份 / 领域事实 / 域边界 / 工具索引
#       suffix (order 10200)  红线 + 全量域块（装配在最末，作为最终适用的约束集）
#
# 内容随包分发（data/ + 语料 submodule），运行期不读工作区、不联网。

`;
  const document = [
    {
      insert: [
        {
          id: "vrchat-kb",
          name: "dsh-vrchat-kb",
          config: { tier: "lite" },
        },
        {
          id: "preset-vrchat",
          name: "@deepseek-ai/dsh-agent-preset",
          config: {
            id: "vrchat",
            name: "VRChat 创作模式",
            description: "VRChat World/Avatar/API 开发：专家人设 + 红线 + 全量领域知识。",
            order: 20,
            plugins: [
              {
                id: "persona",
                name: "@deepseek-ai/dsh-persona",
                config: {
                  prefix: personaPrefix.trim(),
                  suffix: personaSuffix.trim(),
                },
              },
              {
                id: "vrchat-kb-preset",
                name: "dsh-vrchat-kb",
                config: { tier: "preset" },
              },
            ],
          },
        },
      ],
    },
  ];
  // Serialized, never templated: hand-built YAML is where the block scalars broke.
  return `${header}${YAML.stringify(document, { lineWidth: 0 })}`;
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

  // Preset mode: the full digest, plus the coverage map as its opening section.
  const alwaysLoad = [
    loaded["domain-map"],
    loaded["t1-world"],
    loaded["t1-avatar"],
    loaded["t1-shader"],
  ].join("\n\n---\n\n");
  await writeFile(join(dataDir, "always-load.txt"), alwaysLoad, "utf8");

  // ── Persona prefix / suffix ──────────────────────────────────────────────
  // Injected ONLY by the preset. There is no global VRChat section: a session
  // that never opts into the preset pays nothing, because opting in is what
  // makes the whole body of knowledge relevant.
  //
  //   prefix (order 0)      identity, domain facts, boundaries, tool index
  //   suffix (order 10200)  the red lines and the full domain digest
  //
  // The suffix sits last in the assembled prompt, which is where a model reads
  // whatever it should treat as the operative constraint set.
  const personaPrefix = (() => {
    try {
      const raw = readFileSync(join(contentSrc, "persona-prefix.md"), "utf8");
      return raw.replace(/^---[\s\S]*?---\n/, "").trim();
    } catch {
      return "";
    }
  })();
  await writeFile(join(dataDir, "persona-prefix.txt"), personaPrefix, "utf8");

  // The suffix is assembled from the curated blocks, so the red lines live once.
  const personaSuffix = [
    "# VRChat 硬约束与领域知识",
    "",
    loaded["t0-core"].replace(/^# .*\n+/, "").trim(),
    "",
    "---",
    "",
    alwaysLoad,
  ].join("\n").trim();
  await writeFile(join(dataDir, "persona-suffix.txt"), personaSuffix, "utf8");

  await writeFile(
    join(workspaceRoot, "cordis.patch.yml"),
    renderPatch(personaPrefix, personaSuffix),
    "utf8",
  );

  // ── 2. Retrieval index (derived only) ─────────────────────────────────────
  // The raw pages are NOT copied anywhere: they are the submodule, i.e. part of
  // the plugin body, read in place at query time. `data/` carries only what the
  // build DERIVES from them — metadata the store needs up front so a query does
  // not have to walk 414 files to learn what exists.
  const files = await walkMarkdown(corpusRoot);
  const index = [];

  // A `data/corpus/` from an earlier build would duplicate the submodule inside
  // the package; remove it so the body is not shipped twice.
  try {
    await rm(join(dataDir, "corpus"), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }

  for (const file of files) {
    const rel = posix.join(...relative(corpusRoot, file).split("\\"));
    const raw = await readText(file);
    const { meta } = parseFrontmatter(raw);
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
  }

  index.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(dataDir, "index.json"), JSON.stringify(index, null, 2), "utf8");

  // Remove a pages.json left by an earlier build: it was a single 3.7 MB blob
  // holding a second copy of what the submodule already has.
  try {
    await unlink(join(dataDir, "pages.json"));
  } catch {
    /* already absent */
  }

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
